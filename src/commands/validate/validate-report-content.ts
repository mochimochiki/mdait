/**
 * @file validate-report-content.ts
 * @description
 *   検証結果（ValidationReport）からレポート用 Markdown を生成する純粋関数。
 *   vscode 依存なし。見出し・定型文は VS Code 層から表示言語のものを注入する（ADR-260719-01）。
 * @module commands/validate/validate-report-content
 */
import type { ValidationReport, ValidationViolation } from "./validate-command";

/** レポートの見出し・定型文（VS Code 層から表示言語のものを注入する。既定は英語） */
export interface ValidateReportLabels {
	title: string;
	summary: string;
	filesChecked: string;
	unitsChecked: string;
	unitsSkipped: string;
	violationsHeading: string;
	noViolations: string;
	unit: string;
}

/** ラベル未注入時の既定（英語） */
const DEFAULT_VALIDATE_REPORT_LABELS: ValidateReportLabels = {
	title: "Validation Results",
	summary: "Summary",
	filesChecked: "Files checked",
	unitsChecked: "Units checked",
	unitsSkipped: "Units skipped (need pending)",
	violationsHeading: "Violations",
	noViolations: "(no violations)",
	unit: "unit",
};

/**
 * 検証レポートの Markdown を生成する純粋関数。
 * 違反はファイルごとにまとめ、`check` 種別と対象ユニットの hash を添える。
 */
export function generateValidateReportContent(
	report: ValidationReport,
	labels: ValidateReportLabels = DEFAULT_VALIDATE_REPORT_LABELS,
): string {
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

	const lines: string[] = [];
	lines.push(`# ${labels.title} - ${timestamp}`);
	lines.push("");
	lines.push(`## ${labels.summary}`);
	lines.push("");
	lines.push(`- ${labels.filesChecked}: ${report.filesChecked}`);
	lines.push(`- ${labels.unitsChecked}: ${report.unitsChecked}`);
	lines.push(`- ${labels.unitsSkipped}: ${report.unitsSkipped}`);
	lines.push("");
	lines.push(`## ${labels.violationsHeading} (${report.violations.length})`);
	lines.push("");

	if (report.violations.length === 0) {
		lines.push(labels.noViolations);
		lines.push("");
		return lines.join("\n");
	}

	const byFile = new Map<string, ValidationViolation[]>();
	for (const violation of report.violations) {
		const list = byFile.get(violation.file);
		if (list) {
			list.push(violation);
		} else {
			byFile.set(violation.file, [violation]);
		}
	}

	for (const [file, violations] of byFile) {
		lines.push(`### [${file}](/${file})`);
		lines.push("");
		for (const violation of violations) {
			lines.push(`- \`${violation.check}\` ${violation.message} (${labels.unit}: \`${violation.unitHash}\`)`);
		}
		lines.push("");
	}

	return lines.join("\n");
}
