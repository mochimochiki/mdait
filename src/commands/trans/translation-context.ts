/**
 * 翻訳処理に渡すコンテキスト情報。
 * AI翻訳の品質向上のために、翻訳対象のテキストの周辺情報や用語集などを提供します。
 */
export class TranslationContext {
	/**
	 * 翻訳対象ユニットの直前のユニットの本文。
	 */
	previousText?: string;

	/**
	 * 翻訳対象ユニットの直後のユニットの本文。
	 */
	nextText?: string;

	/**
	 * 適用する用語集の文字列。
	 * 将来的にはファイルパスや構造化されたデータも検討。
	 */
	glossary?: string;

	/**
	 * その他のコンテキスト情報。将来的な拡張用。
	 */
	[key: string]: unknown;

	constructor(previousText?: string, nextText?: string, glossary?: string) {
		this.previousText = previousText;
		this.nextText = nextText;
		this.glossary = glossary;
	}
}
