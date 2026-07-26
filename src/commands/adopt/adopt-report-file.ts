/**
 * @file adopt-report-file.ts
 * @description
 *   取り込みウィザードの統合レポートを組み立て、共通のレポート出力経路
 *   （commands/shared/report-file.ts）へ渡す。書き出し先・開き方・通知の作法は
 *   全レポート共通なのでここには持たない。
 * @module commands/adopt/adopt-report-file
 */
import * as path from "node:path";
import type * as vscode from "vscode";
import type { Configuration } from "../../infra/config/configuration";
import { writeReport } from "../shared/report-file";
import { type AdoptOutcome, generateAdoptReportContent } from "./adopt-result";
import { createAdoptReportLabels } from "./report-l10n";

export { openReport as openAdoptReport } from "../shared/report-file";

/**
 * 統合レポートを `.mdait/reports/adopt.md` へ書き出す。
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
	const content = generateAdoptReportContent(outcome, {
		labels: createAdoptReportLabels(),
		// リンクはレポートの置き場所（.mdait/reports/）からの相対パスで解決される
		linkBaseDir: path.dirname(config.getReportFilePath("adopt")),
	});
	return writeReport(config, "adopt", content);
}
