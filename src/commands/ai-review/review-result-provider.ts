import * as path from "node:path";
/**
 * @file review-result-provider.ts
 * @description
 *   AI翻訳レビュー結果のレポートを組み立て、共通のレポート出力経路
 *   （commands/shared/report-file.ts）へ渡す。
 *   以前は仮想ドキュメントで表示していたため行リンクが張れず、再読み込みで内容が消えていた。
 *   実ファイルにしたことで、ファイル名・ユニット列が該当箇所へのリンクになる。
 *
 *   あわせて、flagged 行に「note を編集」CodeLens を出すプロバイダーを提供する。
 * @module commands/ai-review/review-result-provider
 */
import * as vscode from "vscode";
import { Configuration } from "../../infra/config/configuration";
import { normalizeFileKey } from "../../infra/workspace/file-key";
import { writeReport } from "../shared/report-file";
import type { AiReviewFileResult } from "./review-result";
import { type ReportAnchor, buildReviewReport } from "./review-table";

/** 直近の書き出しで得た flagged 行のアンカー（CodeLensProvider から参照） */
let latestAnchors: ReportAnchor[] = [];

/** アンカー更新を CodeLensProvider へ知らせる */
const onDidWriteReport = new vscode.EventEmitter<void>();

/**
 * AIレビューレポートを `.mdait/reports/ai-review.md` へ書き出す。
 *
 * @returns 書き出したファイルの URI（失敗時は undefined）
 */
export async function writeAiReviewReport(results: AiReviewFileResult[]): Promise<vscode.Uri | undefined> {
	const config = Configuration.getInstance();
	const { content, anchors } = buildReviewReport(results, {
		labels: { title: vscode.l10n.t("mdait AI Translation Review") },
		// リンクはレポートの置き場所（.mdait/reports/）からの相対パスで解決される
		linkBaseDir: path.dirname(config.getReportFilePath("ai-review")),
	});
	latestAnchors = anchors;
	const uri = await writeReport(config, "ai-review", content);
	onDidWriteReport.fire();
	return uri;
}

/**
 * AIレビューレポートの flagged 行に「note を編集」CodeLens を出すプロバイダー。
 * クリックすると該当ユニットへジャンプして note 入力を開く（mdait.unit.editNoteForUnit）。
 */
export class AiReviewResultCodeLensProvider implements vscode.CodeLensProvider {
	private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
	readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

	constructor() {
		// レポートが書き直されたら CodeLens も貼り直す
		onDidWriteReport.event(() => this._onDidChangeCodeLenses.fire());
	}

	provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		// レポート実ファイルのみを対象にする。生の文字列比較では Windows のドライブレターや
		// 大文字小文字の表記差で一致せず CodeLens が出ないため、正規化して比べる
		if (
			normalizeFileKey(document.uri.fsPath) !==
			normalizeFileKey(Configuration.getInstance().getReportFilePath("ai-review"))
		) {
			return [];
		}
		return latestAnchors.map((anchor) => {
			const range = new vscode.Range(anchor.line, 0, anchor.line, 0);
			return new vscode.CodeLens(range, {
				title: vscode.l10n.t("$(comment) Add / edit note"),
				tooltip: vscode.l10n.t("Tooltip: Jump to this unit and edit its note (shown to the AI during audit)"),
				command: "mdait.unit.editNoteForUnit",
				arguments: [anchor.filePath, anchor.unitHash],
			});
		});
	}
}
