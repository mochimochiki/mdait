/**
 * @file adopt-report-file.ts
 * @description
 *   取り込みウィザードの統合レポートを `.mdait/adopt-report.md` の実ファイルとして書き出し、
 *   Markdown プレビューで開く（ADR-260719-01）。実ファイルにすることで、プレビュー・
 *   該当箇所への行リンク・git 差分といった VS Code 標準機能をそのまま利用できる。
 *   実行ごとに上書きする（履歴は git に委ねる）。
 * @module commands/adopt/adopt-report-file
 */
import * as path from "node:path";
import * as vscode from "vscode";
import type { Configuration } from "../../infra/config/configuration";
import { Logger, formatError } from "../../infra/logging/logger";
import { ensureMdaitDir } from "../../infra/workspace/mdait-dir";
import { type AdoptOutcome, generateAdoptReportContent } from "./adopt-result";
import { createAdoptReportLabels } from "./report-l10n";

const logger = Logger.getInstance();

/**
 * 統合レポートを `.mdait/adopt-report.md` へ書き出す。
 * ユニット列は該当箇所への行リンクになり、見出し・定型文は表示言語で出力される。
 *
 * @param config 設定（レポートの出力先解決に使う）
 * @param outcome 取り込み1回分の結果
 * @returns 書き出したファイルの URI（失敗時は undefined）
 */
export async function writeAdoptReport(
	config: Configuration,
	outcome: AdoptOutcome,
): Promise<vscode.Uri | undefined> {
	try {
		const mdaitDir = await ensureMdaitDir();
		if (!mdaitDir) {
			return undefined;
		}
		const reportPath = config.getAdoptReportFilePath();
		const content = generateAdoptReportContent(outcome, {
			labels: createAdoptReportLabels(),
			// リンクはレポートの置き場所（.mdait/）からの相対パスで解決される
			linkBaseDir: path.dirname(reportPath),
		});
		const uri = vscode.Uri.file(reportPath);
		await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
		return uri;
	} catch (error) {
		logger.warn("adopt", "Failed to write adopt report", formatError(error));
		return undefined;
	}
}

/**
 * 書き出したレポートを Markdown プレビューで開く（リンクを踏めるようにするため）。
 */
export async function openAdoptReport(uri: vscode.Uri): Promise<void> {
	try {
		await vscode.commands.executeCommand("markdown.showPreview", uri);
	} catch (error) {
		logger.warn("adopt", "Failed to open adopt report preview", formatError(error));
		try {
			// プレビューが使えない環境ではテキストとして開く
			const doc = await vscode.workspace.openTextDocument(uri);
			await vscode.window.showTextDocument(doc, { preview: true });
		} catch (fallbackError) {
			// 取り込み自体は成功しているので、表示の失敗で取り込みを失敗扱いにしない
			logger.warn("adopt", "Failed to open adopt report", formatError(fallbackError));
		}
	}
}
