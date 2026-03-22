/**
 * @file tm-reference-formatter.ts
 * @description TM検索結果をプロンプト用にフォーマットするユーティリティ。
 * VS Code非依存のため、Core層に配置。
 */

import type { TmMatch } from "./types";

/**
 * TM検索結果をプロンプト用にフォーマットする。
 * @param matches TM検索結果配列
 * @returns フォーマット済み文字列
 */
export function formatTmReferences(matches: TmMatch[]): string {
	return matches
		.map((m, i) => {
			const from = m.firstUsedIn ? ` (from: ${m.firstUsedIn})` : "";
			return `${i + 1}. Source: "${m.source}"\n   Translation: "${m.target}"${from}`;
		})
		.join("\n\n");
}
