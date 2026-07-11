/**
 * @file review-result-provider.ts
 * @description
 *   AIペアリング検証結果のプレビューを提供する TextDocumentContentProvider。
 *   固定 URI + onDidChange による上書き更新方式で既存タブを再利用する
 *   （tm-result-provider.ts と同パターン）。レポート本文の生成は VS Code 非依存の
 *   review-table.ts に委譲する。
 *   あわせて、flagged 行に「note を編集」CodeLens を出す CodeLensProvider を提供し、
 *   レポート → 該当ユニットの note 編集へジャンプできるようにする。
 * @module commands/ai-review/review-result-provider
 */
import * as vscode from "vscode";
import type { AiReviewFileResult } from "./review-result";
import { type ReportAnchor, buildReviewReport } from "./review-table";

const SCHEME = "mdait-ai-review";
const PREVIEW_URI = vscode.Uri.parse(`${SCHEME}:ai-review-result`);

/**
 * AIペアリング検証結果の仮想ドキュメントを提供するシングルトン。
 * extension.ts で `workspace.registerTextDocumentContentProvider` に登録して使用する。
 */
export class AiReviewResultContentProvider implements vscode.TextDocumentContentProvider {
	private static instance: AiReviewResultContentProvider;
	private latestContent = "";
	private anchors: ReportAnchor[] = [];
	private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();

	readonly onDidChange = this._onDidChange.event;

	private constructor() {}

	static getInstance(): AiReviewResultContentProvider {
		if (!AiReviewResultContentProvider.instance) {
			AiReviewResultContentProvider.instance = new AiReviewResultContentProvider();
		}
		return AiReviewResultContentProvider.instance;
	}

	/** 最新の結果をセットし、既存タブの内容を更新する。 */
	setContent(results: AiReviewFileResult[]): void {
		const { content, anchors } = buildReviewReport(results);
		this.latestContent = content;
		this.anchors = anchors;
		this._onDidChange.fire(PREVIEW_URI);
	}

	provideTextDocumentContent(_uri: vscode.Uri): string {
		return this.latestContent;
	}

	/** flagged 行のアンカー（CodeLensProvider から参照） */
	getAnchors(): ReportAnchor[] {
		return this.anchors;
	}

	dispose(): void {
		this._onDidChange.dispose();
	}

	/** プレビュードキュメントを現在のカラムで開く。 */
	static async openPreview(): Promise<void> {
		const doc = await vscode.workspace.openTextDocument(PREVIEW_URI);
		await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Active, preview: true });
	}
}

/**
 * AIレビュー結果レポート（仮想ドキュメント）の flagged 行に
 * 「note を編集」CodeLens を出すプロバイダー。
 * クリックすると該当ユニットへジャンプして note 入力を開く（mdait.unit.editNoteForUnit）。
 */
export class AiReviewResultCodeLensProvider implements vscode.CodeLensProvider {
	private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
	readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

	constructor() {
		// レポート内容が更新されたら CodeLens も貼り直す
		AiReviewResultContentProvider.getInstance().onDidChange(() => this._onDidChangeCodeLenses.fire());
	}

	provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		if (document.uri.scheme !== SCHEME) {
			return [];
		}
		const anchors = AiReviewResultContentProvider.getInstance().getAnchors();
		return anchors.map((anchor) => {
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
