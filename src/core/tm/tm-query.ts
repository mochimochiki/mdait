import { normalizeForTm } from "./tm-text-normalizer";

/**
 * テキストを正規化し、文単位の検索クエリ集合へ変換する。
 */
export function buildSentenceQueries(text: string, lang: string, minQueryLength: number): Set<string> {
	const normalized = normalizeForTm(text);
	const lines = normalized.split("\n");
	const segmenter = new Intl.Segmenter(lang, { granularity: "sentence" });
	const result = new Set<string>();
	for (const raw of lines) {
		const trimmed = raw.trim();
		for (const { segment } of segmenter.segment(trimmed)) {
			const sentence = segment.trim();
			if (sentence.length >= minQueryLength) {
				result.add(sentence);
			}
		}
	}
	return result;
}
