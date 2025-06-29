/**
 * テキスト正規化オプション
 */
export interface NormalizationOptions {
	/** 先頭と末尾の空白を削除する */
	trim?: boolean;
	/** 連続する空白を1つに置き換える */
	collapseSpaces?: boolean;
	/** 改行コードを統一する (LF) */
	normalizeNewlines?: boolean;
}

/**
 * デフォルトの正規化オプション
 */
const DEFAULT_OPTIONS: NormalizationOptions = {
	trim: true,
	collapseSpaces: true,
	normalizeNewlines: true,
};

/**
 * テキスト正規化クラス
 * ハッシュ計算前のテキスト正規化を行う
 */
export class TextNormalizer {
	private options: NormalizationOptions;

	/**
	 * コンストラクタ
	 * @param options 正規化オプション
	 */
	constructor(options: NormalizationOptions = DEFAULT_OPTIONS) {
		this.options = { ...DEFAULT_OPTIONS, ...options };
	}

	/**
	 * テキストを正規化する
	 * @param text 正規化する文字列
	 * @returns 正規化された文字列
	 */
	normalize(text: string): string {
		let result = text;

		// 改行コードの正規化 (CR+LF -> LF)
		if (this.options.normalizeNewlines) {
			result = result.replace(/\r\n/g, "\n");
		}

		// 空白の正規化
		if (this.options.collapseSpaces) {
			result = result.replace(/[ \t]+/g, " ");
		}

		// 改行後の空白を削除
		if (this.options.collapseSpaces) {
			result = result.replace(/\n[ \t]+/g, "\n");
		}

		// 先頭と末尾の空白を削除
		if (this.options.trim) {
			result = result.trim();
		}

    // 3つ以上の連続する改行はすべて2つの改行に置き換え（フォーマッターなどによる影響を抑えるため）
    result = result.replace(/\n{3,}/g, "\n\n");

    // 末尾の改行はすべて無視
    result = result.replace(/\n+$/g, "");

		return result;
	}
}

/**
 * テキストを標準の設定で正規化する
 * @param text 正規化する文字列
 * @returns 正規化された文字列
 */
export function normalizeText(text: string): string {
	const normalizer = new TextNormalizer(); // インスタンスを直接作成
	return normalizer.normalize(text);
}
