/**
 * @file validate-report-file.ts
 * @description
 *   検証結果のレポートを組み立て、共通のレポート出力経路
 *   （commands/shared/report-file.ts）へ渡す。
 * @module commands/validate/validate-report-file
 */
import * as vscode from "vscode";
import { Configuration } from "../../infra/config/configuration";
import { writeReport } from "../shared/report-file";
import type { ValidationReport } from "./validate-command";
import { generateValidateReportContent } from "./validate-report-content";

/**
 * 検証レポートを `.mdait/reports/validate.md` へ書き出す。
 * 見出し・定型文は表示言語で出す（ADR-260719-01）。
 *
 * @returns 書き出したファイルの URI（失敗時は undefined）
 */
export async function writeValidateReport(report: ValidationReport): Promise<vscode.Uri | undefined> {
	const content = generateValidateReportContent(report, {
		title: vscode.l10n.t("Validation Results"),
		summary: vscode.l10n.t("Summary"),
		filesChecked: vscode.l10n.t("Files checked"),
		unitsChecked: vscode.l10n.t("Units checked"),
		unitsSkipped: vscode.l10n.t("Units skipped (need pending)"),
		violationsHeading: vscode.l10n.t("Violations"),
		noViolations: vscode.l10n.t("(no violations)"),
		unit: vscode.l10n.t("unit"),
	});
	return writeReport(Configuration.getInstance(), "validate", content);
}
