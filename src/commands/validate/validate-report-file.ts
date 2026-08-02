/**
 * @file validate-report-file.ts
 * @description
 *   確定的な検査（構造チェック＋用語一貫性）の結果セクションを、表示言語つきで組み立てる。
 *   単独のレポートファイルは持たず、✨AIレビューのレポートへ結合される（ADR-260802-02）。
 * @module commands/validate/validate-report-file
 */
import * as vscode from "vscode";
import type { ValidationReport } from "./validate-command";
import { generateValidateReportContent } from "./validate-report-content";

/**
 * 確定的な検査の結果セクション（Markdown）を表示言語で組み立てる。
 * 呼び出し側（AIレビューのレポート出力）が本文へ結合する。
 */
export function buildValidateReportSection(report: ValidationReport): string {
	return generateValidateReportContent(report, {
		title: vscode.l10n.t("Deterministic checks (structure & terminology)"),
		filesChecked: vscode.l10n.t("Files checked"),
		unitsChecked: vscode.l10n.t("Units checked"),
		unitsSkipped: vscode.l10n.t("Units skipped (need pending)"),
		violationsHeading: vscode.l10n.t("Violations"),
		noViolations: vscode.l10n.t("(no violations)"),
		unit: vscode.l10n.t("unit"),
	});
}
