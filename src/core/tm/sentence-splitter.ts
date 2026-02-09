/**
 * Intl.Segmenter ベースの文分割。
 * trans実行時のTM検索で使用する。
 *
 * 分割ルール:
 * 1. コードブロック（```）、インラインコード（`）をプレースホルダーに置換（保護）
 * 2. リスト項目を独立文として分割
 * 3. Intl.Segmenter(lang, { granularity: "sentence" }) で文境界を検出
 * 4. 各文をトリム、空文字列除去
 */

/** コードブロックのプレースホルダー接頭辞 */
const CODE_BLOCK_PLACEHOLDER_PREFIX = "\u0000CB";
/** インラインコードのプレースホルダー接頭辞 */
const INLINE_CODE_PLACEHOLDER_PREFIX = "\u0000IC";

/** コードブロック正規表現（```...```） */
const CODE_BLOCK_REGEX = /```[\s\S]*?```/g;
/** インラインコード正規表現（`...`） */
const INLINE_CODE_REGEX = /`[^`\n]+`/g;

/** リスト項目の行パターン */
const LIST_ITEM_REGEX = /^(\s*[-*+]\s+|\s*\d+\.\s+)/;

/** 言語ごとの Intl.Segmenter キャッシュ */
const segmenterCache = new Map<string, Intl.Segmenter>();

/**
 * 言語に対応する Intl.Segmenter を取得する。キャッシュがあればそれを返す。
 */
function getSegmenter(lang: string): Intl.Segmenter {
	const key = lang.toLowerCase();
	let segmenter = segmenterCache.get(key);
	if (!segmenter) {
		segmenter = new Intl.Segmenter(key, { granularity: "sentence" });
		segmenterCache.set(key, segmenter);
	}
	return segmenter;
}

/**
 * Intl.Segmenter ベースの文分割クラス。
 * trans検索時の文分割で使用する。
 */
export class SentenceSplitter {
	/**
	 * テキストを文単位に分割する。
	 * @param text 分割対象テキスト
	 * @param lang 言語コード ("ja", "en" など)
	 * @returns 分割された文の配列
	 */
	split(text: string, lang: string): string[] {
		if (!text.trim()) {
			return [];
		}

		// 1. コードブロック・インラインコードを保護
		const codeBlocks: string[] = [];
		const inlineCodes: string[] = [];

		let protected_ = text.replace(CODE_BLOCK_REGEX, (match) => {
			const index = codeBlocks.length;
			codeBlocks.push(match);
			return `${CODE_BLOCK_PLACEHOLDER_PREFIX}${index}\u0000`;
		});

		protected_ = protected_.replace(INLINE_CODE_REGEX, (match) => {
			const index = inlineCodes.length;
			inlineCodes.push(match);
			return `${INLINE_CODE_PLACEHOLDER_PREFIX}${index}\u0000`;
		});

		// 2. 段落分割（空行区切り）
		const paragraphs = protected_.split(/\n\n+/);
		const sentences: string[] = [];

		for (const paragraph of paragraphs) {
			const trimmed = paragraph.trim();
			if (!trimmed) {
				continue;
			}

			// リスト項目の処理: 行単位で分割
			const lines = trimmed.split("\n");
			const isList = lines.some((line) => LIST_ITEM_REGEX.test(line));
			if (isList) {
				for (const line of lines) {
					const cleanLine = line.replace(LIST_ITEM_REGEX, "").trim();
					if (cleanLine) {
						sentences.push(cleanLine);
					}
				}
				continue;
			}

			// 段落内の改行を空白に結合
			const joined = lines.map((l) => l.trim()).join(" ");

			// Intl.Segmenter で文分割
			const splitSentences = this.splitBySentenceBoundary(joined, lang);
			sentences.push(...splitSentences);
		}

		// 3. プレースホルダーを復元し、トリム、空文字列除去
		return sentences
			.map((s) => this.restorePlaceholders(s, codeBlocks, inlineCodes))
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
	}

	/**
	 * Intl.Segmenter を使用して文境界で分割する。
	 */
	private splitBySentenceBoundary(text: string, lang: string): string[] {
		const segmenter = getSegmenter(lang);
		const segments = segmenter.segment(text);
		const result: string[] = [];
		for (const { segment } of segments) {
			const trimmed = segment.trim();
			if (trimmed) {
				result.push(trimmed);
			}
		}
		return result;
	}

	/**
	 * プレースホルダーを元のコードに復元する。
	 */
	private restorePlaceholders(text: string, codeBlocks: string[], inlineCodes: string[]): string {
		let result = text;
		// コードブロック復元
		result = result.replace(new RegExp(`${CODE_BLOCK_PLACEHOLDER_PREFIX}(\\d+)\u0000`, "g"), (_, indexStr) => {
			const index = Number.parseInt(indexStr, 10);
			return codeBlocks[index] ?? "";
		});
		// インラインコード復元
		result = result.replace(new RegExp(`${INLINE_CODE_PLACEHOLDER_PREFIX}(\\d+)\u0000`, "g"), (_, indexStr) => {
			const index = Number.parseInt(indexStr, 10);
			return inlineCodes[index] ?? "";
		});
		return result;
	}
}
