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

const TARGET_NOT_DETECTED = "(target not detected)";

/**
 * term-detect 結果からプレビュー用テキストを生成する純粋関数。
 */
export function generateContent(result: TermDetectResult): string {
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

	const lines: string[] = [];
	lines.push(`# Term Detect Results - ${timestamp}`);
	lines.push("");

	lines.push(`## Detected (${result.entries.length})`);
	if (result.entries.length === 0) {
		lines.push("(none)");
		lines.push("");
	} else {
		for (const entry of result.entries) {
			const sourceTerm = entry.languages[result.sourceLang]?.term;
			lines.push(`"${sourceTerm ?? ""}"`);

			const targetTerm = entry.languages[result.targetLang]?.term;
			if (targetTerm) {
				lines.push(`  \u2192 "${targetTerm}"`);
			} else {
				lines.push(`  ${TARGET_NOT_DETECTED}`);
			}

			if (entry.context) {
				lines.push(`  context: ${entry.context}`);
			}

			lines.push("");
		}
	}

	return lines.join("\n");
}
