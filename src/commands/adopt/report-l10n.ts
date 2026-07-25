/**
 * @file report-l10n.ts
 * @description
 *   レポートの見出し・定型文を VS Code の表示言語で組み立てるラベルファクトリ（ADR-260719-01）。
 *   レポート本体の生成は VS Code 非依存の純関数（adopt-result / review-table）に置いたまま、
 *   ラベル構築だけをこの UI 層に閉じ込めることで「純関数のテスト可能性」と「l10n 抽出」を両立する。
 *   件数の語彙行（`adopted: 3 | ...`）とエージェント向け nextActions は共通語彙として英語のままにする。
 *   英語の原文は純関数側の `DEFAULT_ADOPT_REPORT_LABELS` と一致させること
 *   （l10n 抽出のためリテラルが必要で、既定値と二重に持つことになるため）。
 * @module commands/adopt/report-l10n
 */
import * as vscode from "vscode";
import type { AdoptReportLabels } from "./adopt-result";

/**
 * 取り込みウィザードの統合レポート用ラベルを表示言語で組み立てる。
 */
export function createAdoptReportLabels(): AdoptReportLabels {
	return {
		title: vscode.l10n.t("mdait Adopt Existing Translations"),
		syncHeading: vscode.l10n.t("Sync (adopt + AI align)"),
		syncNotRun: vscode.l10n.t("Sync did not run (check the mdait configuration)."),
		filesLine: (processed, failed) => vscode.l10n.t("files: {0} processed, {1} failed", processed, failed),
		reviewHeading: vscode.l10n.t("AI Translation Review"),
		dryRunNote: vscode.l10n.t("_dry run: no markers were changed; glossary and TM steps were skipped._"),
		glossaryHeading: vscode.l10n.t("Glossary"),
		tmHeading: vscode.l10n.t("Translation Memory"),
		stageErrorsHeading: vscode.l10n.t("Stage errors"),
	};
}
