/**
 * @file term-result-content.ts
 * @description
 *   term-detect 結果からプレビュー用テキストを生成する純粋関数。
 *   term-result-provider.ts から抽出。vscode依存なし。
 * @module commands/term/term-result-content
 */
import type { TermEntry } from "./term-entry";

/** term-detect 結果をまとめた型 */
export interface TermDetectResult {
	readonly entries: readonly TermEntry[];
	readonly sourceLang: string;
	readonly targetLang: string;
}

/** プレビューの見出し・定型文（VS Code 層から表示言語のものを注入する。既定は英語） */
export interface TermResultLabels {
	title: string;
	detectedHeading: string;
	none: string;
	targetNotDetected: string;
	context: string;
}

/** ラベル未注入時の既定（英語） */
export const DEFAULT_TERM_RESULT_LABELS: TermResultLabels = {
	title: "Term Detect Results",
	detectedHeading: "Detected",
	none: "(none)",
	targetNotDetected: "(target not detected)",
	context: "context",
};

/**
 * term-detect 結果からプレビュー用テキストを生成する純粋関数。
 *
 * @param result 用語検出の結果
 * @param labels 見出し・定型文のラベル（省略時は英語の既定）
 */
export function generateContent(
	result: TermDetectResult,
	labels: TermResultLabels = DEFAULT_TERM_RESULT_LABELS,
): string {
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

	const lines: string[] = [];
	lines.push(`# ${labels.title} - ${timestamp}`);
	lines.push("");

	lines.push(`## ${labels.detectedHeading} (${result.entries.length})`);
	if (result.entries.length === 0) {
		lines.push(labels.none);
		lines.push("");
	} else {
		for (const entry of result.entries) {
			const sourceTerm = entry.languages[result.sourceLang]?.term;
			lines.push(`"${sourceTerm ?? ""}"`);

			const targetTerm = entry.languages[result.targetLang]?.term;
			if (targetTerm) {
				lines.push(`  \u2192 "${targetTerm}"`);
			} else {
				lines.push(`  ${labels.targetNotDetected}`);
			}

			if (entry.context) {
				lines.push(`  ${labels.context}: ${entry.context}`);
			}

			lines.push("");
		}
	}

	return lines.join("\n");
}
