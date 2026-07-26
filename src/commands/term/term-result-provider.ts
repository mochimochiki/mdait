/**
 * @file term-result-provider.ts
 * @description
 *   term-detect 結果のレポートを組み立て、共通のレポート出力経路
 *   （commands/shared/report-file.ts）へ渡す。
 *   以前は仮想ドキュメントで表示していたが、行リンクが張れず再読み込みで内容が消えたため
 *   実ファイルへ統一した。
 * @module commands/term/term-result-provider
 */
import * as vscode from "vscode";
import { Configuration } from "../../infra/config/configuration";
import { writeReport } from "../shared/report-file";
import { type TermDetectResult, generateContent } from "./term-result-content";

export type { TermDetectResult } from "./term-result-content";
export { generateContent } from "./term-result-content";

/**
 * 用語検出レポートを `.mdait/reports/term.md` へ書き出す。
 * 見出し・定型文は表示言語で出す（ADR-260719-01）。
 *
 * @returns 書き出したファイルの URI（失敗時は undefined）
 */
export async function writeTermReport(result: TermDetectResult): Promise<vscode.Uri | undefined> {
	const content = generateContent(result, {
		title: vscode.l10n.t("Term Detect Results"),
		detectedHeading: vscode.l10n.t("Detected"),
		none: vscode.l10n.t("(none)"),
		targetNotDetected: vscode.l10n.t("(target not detected)"),
		context: vscode.l10n.t("context"),
	});
	return writeReport(Configuration.getInstance(), "term", content);
}
