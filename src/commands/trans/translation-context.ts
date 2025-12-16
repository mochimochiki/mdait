/**
 * 翻訳処理に渡すコンテキスト情報。
 * AI翻訳の品質向上のために、翻訳対象のテキストの周辺情報や用語集などを提供します。
 */
export class TranslationContext {
	/**
	 * 翻訳対象ユニットの直前のユニットの本文配列。
	 */
	previousTexts: string[] = [];

	/**
	 * 翻訳対象ユニットの直後のユニットの本文配列。
	 */
	nextTexts: string[] = [];

	/**
	 * 適用する用語集の文字列。
	 * 将来的にはファイルパスや構造化されたデータも検討。
	 */
	terms?: string;

	/**
	 * 前回の訳文（原文が改訂された場合に参照）。
	 * 変更不要な部分は既訳を尊重し、変更が必要な箇所のみを変更するための参考情報。
	 */
	previousTranslation?: string;

	/**
	 * 周辺テキストを結合した文字列を取得
	 * @returns 前後のユニットを結合した文字列（存在する場合）
	 */
	get surroundingText(): string | undefined {
		const parts: string[] = [];
		
		if (this.previousTexts.length > 0) {
			parts.push("Previous context:", ...this.previousTexts);
		}
		
		if (this.nextTexts.length > 0) {
			if (parts.length > 0) {
				parts.push(""); // 空行で区切る
			}
			parts.push("Following context:", ...this.nextTexts);
		}
		
		return parts.length > 0 ? parts.join("\n") : undefined;
	}

	/**
	 * その他のコンテキスト情報。将来的な拡張用。
	 */
	[key: string]: unknown;

	constructor(previousTexts: string[] = [], nextTexts: string[] = [], terms?: string, previousTranslation?: string) {
		this.previousTexts = previousTexts;
		this.nextTexts = nextTexts;
		this.terms = terms;
		this.previousTranslation = previousTranslation;
	}
}
