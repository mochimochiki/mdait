/**
 * @file tm-result-content.ts
 * @description
 *   tm-commit 結果からプレビュー用テキストを生成する純粋関数。
 *   tm-result-provider.ts から抽出。vscode依存なし。
 * @module commands/tm/tm-result-content
 */
import type { TmResultItem } from "./commit-processor";

/**
 * tm-commit 結果からプレビュー用テキストを生成する純粋関数。
 */
export function generateContent(result: { newItems: TmResultItem[]; updatedItems: TmResultItem[] }): string {
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

	const lines: string[] = [];
	lines.push(`# TM Commit Results - ${timestamp}`);
	lines.push("");

	lines.push(`## New (${result.newItems.length})`);
	if (result.newItems.length === 0) {
		lines.push("(none)");
		lines.push("");
	} else {
		for (const item of result.newItems) {
			lines.push(`"${item.primary}"`);
			lines.push(`  \u2192 "${item.local}"`);
			lines.push("");
		}
	}

	lines.push(`## Updated (${result.updatedItems.length})`);
	if (result.updatedItems.length === 0) {
		lines.push("(none)");
		lines.push("");
	} else {
		for (const item of result.updatedItems) {
			lines.push(`"${item.primary}"`);
			lines.push(`  \u2192 "${item.local}"`);
			lines.push("");
		}
	}

	return lines.join("\n");
}
