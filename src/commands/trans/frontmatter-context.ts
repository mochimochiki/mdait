/**
 * @file frontmatter-context.ts
 * @description frontmatter の値を訳すときに渡す文脈の組み立て。
 * @module commands/trans/frontmatter-context
 */
import type { TermEntry } from "../term/term-entry";
import { extractRelevantTerms, termsToJson } from "./term-extractor";
import { TranslationContext } from "./translation-context";

/**
 * frontmatter の値を1つ訳すときの文脈を組み立てる。
 *
 * **本文ユニット・非Markdown と同じものを渡す。** 題名や説明にこそ製品名や機能名が
 * そのまま入るので、ここで用語集が届かないと訳語が本文とずれる。しかも AIレビューは
 * frontmatter のペアにも用語集を渡して判定するので、渡さないままだと
 * 「訳すときには教えず、あとで用語が違うと咎める」ことになる。
 *
 * 照合は `markdown: false` で行う。frontmatter の値は Markdown の文書ではなく1つの
 * 文字列なので、コードフェンスやインラインコードの規則を当てる意味がない。
 *
 * 翻訳メモリは呼び手が入れる（引き当てにワークスペースと TMX ストアが要るため）。
 *
 * @param sourceValue 原文側の値
 * @param allTerms 用語集の全エントリ
 * @param sourceLang 原文の言語コード
 * @param targetLang 訳文の言語コード
 * @param previousTranslation 前回の訳文（改訂のときだけ）
 */
export function buildFrontmatterContext(
	sourceValue: string,
	allTerms: readonly TermEntry[],
	sourceLang: string,
	targetLang: string,
	previousTranslation?: string,
): TranslationContext {
	let termsJson: string | undefined;
	if (allTerms.length > 0) {
		const extracted = extractRelevantTerms(sourceValue, allTerms, sourceLang, targetLang, { markdown: false });
		if (extracted.length > 0) {
			termsJson = termsToJson(extracted);
		}
	}
	return new TranslationContext([], [], termsJson, previousTranslation);
}
