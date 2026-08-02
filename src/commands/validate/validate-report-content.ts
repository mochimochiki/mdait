/**
 * @file validate-report-content.ts
 * @description
 *   確定的な検査（構造チェック＋用語一貫性）の結果を、AIレビューレポートへ
 *   埋め込むためのセクション Markdown を生成する純粋関数。vscode 依存なし。
 *   見出し・定型文は VS Code 層から表示言語のものを注入する（ADR-260719-01）。
 *
 *   単独の検証コマンドは廃止し、✨AIレビューの前処理として吸収した（ADR-260802-02）。
 *   そのため本モジュールは「独立したレポート文書」ではなく「セクション」を返す。
 * @module commands/validate/validate-report-content
 */
import type { ValidationReport, ValidationViolation } from "./validate-command";

/** セクションの見出し・定型文（VS Code 層から表示言語のものを注入する。既定は英語） */
export interface ValidateReportLabels {
	/** セクション見出し */
	title: string;
	filesChecked: string;
	unitsChecked: string;
	unitsSkipped: string;
	violationsHeading: string;
	noViolations: string;
	unit: string;
}

/** ラベル未注入時の既定（英語） */
const DEFAULT_VALIDATE_REPORT_LABELS: ValidateReportLabels = {
	title: "Deterministic checks (structure & terminology)",
	filesChecked: "Files checked",
	unitsChecked: "Units checked",
	unitsSkipped: "Units skipped (need pending)",
	violationsHeading: "Violations",
	noViolations: "(no violations)",
	unit: "unit",
};

/**
 * 確定的な検査の結果セクションを生成する純粋関数。
 * 違反はファイルごとにまとめ、`check` 種別と対象ユニットの hash を添える。
 *
 * AIレビューレポートの一部として結合されるため、見出しは `##` から始める。
 */
export function generateValidateReportContent(
	report: ValidationReport,
	labels: ValidateReportLabels = DEFAULT_VALIDATE_REPORT_LABELS,
): string {
	const lines: string[] = [];
	lines.push(`## ${labels.title}`);
	lines.push("");
	lines.push(
		`${labels.filesChecked}: ${report.filesChecked} | ${labels.unitsChecked}: ${report.unitsChecked} | ${labels.unitsSkipped}: ${report.unitsSkipped}`,
	);
	lines.push("");
	lines.push(`### ${labels.violationsHeading} (${report.violations.length})`);
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
		lines.push(`#### [${file}](/${file})`);
		lines.push("");
		for (const violation of violations) {
			lines.push(`- \`${violation.check}\` ${violation.message} (${labels.unit}: \`${violation.unitHash}\`)`);
		}
		lines.push("");
	}

	return lines.join("\n");
}
