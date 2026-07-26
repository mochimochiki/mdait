/**
 * @file tm-result-provider.ts
 * @description
 *   TM登録結果のレポートを組み立て、共通のレポート出力経路
 *   （commands/shared/report-file.ts）へ渡す。
 *   以前は仮想ドキュメントで表示していたが、行リンクが張れず再読み込みで内容が消えたため
 *   実ファイルへ統一した。
 * @module commands/tm/tm-result-provider
 */
import * as vscode from "vscode";
import { Configuration } from "../../infra/config/configuration";
import { writeReport } from "../shared/report-file";
import type { TmCommitResult } from "./commit-processor";
import { generateContent } from "./tm-result-content";

export { generateContent } from "./tm-result-content";

/**
 * TM登録レポートを `.mdait/reports/tm.md` へ書き出す。
 * 見出し・定型文は表示言語で出す（ADR-260719-01）。
 *
 * @returns 書き出したファイルの URI（失敗時は undefined）
 */
export async function writeTmReport(
	result: Pick<TmCommitResult, "newItems" | "updatedItems">,
): Promise<vscode.Uri | undefined> {
	const content = generateContent(result, {
		title: vscode.l10n.t("TM Commit Results"),
		newHeading: vscode.l10n.t("New"),
		updatedHeading: vscode.l10n.t("Updated"),
		none: vscode.l10n.t("(none)"),
	});
	return writeReport(Configuration.getInstance(), "tm", content);
}
