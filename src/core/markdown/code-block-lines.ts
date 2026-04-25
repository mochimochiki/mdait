/**
 * @file code-block-lines.ts
 * @description
 *   Markdown文書中で、Markdownの仕様上「コードブロック内」と判定される行番号集合を返すユーティリティ。
 *   行スキャン系の機能（CodeLens、ハイライト、Hover、Decorator等）が
 *   コードブロック内のmdaitマーカーを無視するための判定に用いる。
 * @module core/markdown/code-block-lines
 */
import MarkdownIt from "markdown-it";

const md = new MarkdownIt({ breaks: true });

/**
 * 文書中で「コードブロック内」とみなされる行番号（0-indexed）の集合を返す。
 *
 * markdown-it のトークン種別 `code_block`（インデントコードブロック）と
 * `fence`（フェンスドコードブロック）に該当するトークンの `token.map`
 * 範囲 `[start, end)` をすべて Set に展開する。
 *
 * インラインコード（`` ` ``）は対象外。
 *
 * @param content Markdown本文（frontmatterを含んでも構わない）
 * @returns コードブロックの内側に属する行番号の Set（0-indexed）
 */
export function getCodeBlockLineSet(content: string): Set<number> {
	const lines = new Set<number>();
	const tokens = md.parse(content, {});

	for (const token of tokens) {
		if ((token.type === "code_block" || token.type === "fence") && token.map) {
			const [start, end] = token.map;
			for (let line = start; line < end; line++) {
				lines.add(line);
			}
		}
	}

	return lines;
}
