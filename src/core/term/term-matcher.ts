/**
 * @file term-matcher.ts
 * @description
 *   用語照合の純関数群。ユニット本文に用語（正規形＋variants）が出現するかを判定する。
 *   コードブロック・インラインコード内の出現は照合対象から除外できる。
 *   VS Code API 非依存・単体テスト可能（G9: term ロジックの core 移設の起点）。
 * @module core/term/term-matcher
 */
import { getCodeBlockLineSet } from "../markdown/code-block-lines";

/**
 * テキスト内に用語が含まれるかチェック（単純部分一致）
 *
 * 単語境界は考慮しない: 日本語など境界が不明確な言語では単純な文字列検索で十分であり、
 * 英語の活用形（例: "translate" と "translated"）も拾える利点がある。
 * 偽陽性は variants 追加で運用回避する（既知の限界）。
 */
export function textContainsTerm(text: string, term: string): boolean {
	if (!term) {
		return false;
	}
	return text.includes(term);
}

/**
 * 用語（正規形＋variants）のいずれかがテキストに含まれるかチェック
 */
export function anyTermVariantAppears(text: string, term: string, variants: readonly string[] = []): boolean {
	if (textContainsTerm(text, term)) {
		return true;
	}
	return variants.some((variant) => textContainsTerm(text, variant));
}

/**
 * Markdownコンテンツからコードセグメントを除去したテキストを返す。
 * - フェンス付きコードブロックの行（getCodeBlockLineSet 準拠）を除去
 * - インラインコード（`...`）を除去
 *
 * 用語照合でコード内のシンボル・サンプルマーカー等への誤マッチを防ぐために使う。
 */
export function stripCodeSegments(content: string): string {
	const codeBlockLines = getCodeBlockLineSet(content);
	const lines = content.split("\n");
	const kept: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (codeBlockLines.has(i)) {
			continue;
		}
		// インラインコードを除去（行内の `...` スパン）
		kept.push(lines[i].replace(/`[^`]*`/g, ""));
	}
	return kept.join("\n");
}
