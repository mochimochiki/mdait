/**
 * 正規表現ベースの高速文分割。
 * trans実行時のTM検索で使用する。
 *
 * 分割ルール:
 * 1. コードブロック（```）、インラインコード（`）をプレースホルダーに置換（保護）
 * 2. リスト項目を独立文として分割
 * 3. 日本語: [。！？] の後で分割。数値内ドット（3.14）は保護
 * 4. 英語: [.!?]\s+(?=[A-Z]) で分割
 * 5. 各文をトリム、空文字列除去
 */

/** コードブロックのプレースホルダー接頭辞 */
const CODE_BLOCK_PLACEHOLDER_PREFIX = "\u0000CB";
/** インラインコードのプレースホルダー接頭辞 */
const INLINE_CODE_PLACEHOLDER_PREFIX = "\u0000IC";

/** コードブロック正規表現（```...```） */
const CODE_BLOCK_REGEX = /```[\s\S]*?```/g;
/** インラインコード正規表現（`...`） */
const INLINE_CODE_REGEX = /`[^`\n]+`/g;

/** 日本語の句読点による分割（数値内ドット保護済み） */
const JA_SENTENCE_BOUNDARY_REGEX = /([。！？])\s*/g;
/** 英語のピリオド+空白+大文字による分割 */
const EN_SENTENCE_BOUNDARY_REGEX = /([.!?])\s+(?=[A-Z])/g;

/** 数値内ドット保護用プレースホルダー */
const NUMERIC_DOT_PLACEHOLDER = "\u0000ND";
/** 数値内ドット検出パターン (例: 3.14, 1.0) */
const NUMERIC_DOT_REGEX = /(\d)\.(\d)/g;

/** リスト項目の行パターン */
const LIST_ITEM_REGEX = /^(\s*[-*+]\s+|\s*\d+\.\s+)/;

/**
 * 正規表現ベースの文分割クラス。
 * trans検索時の高速分割で使用する。
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

			// 言語別分割
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
	 * 言語別の文境界で分割する。
	 */
	private splitBySentenceBoundary(text: string, lang: string): string[] {
		// 数値内ドットを保護
		const protected_ = text.replace(NUMERIC_DOT_REGEX, `$1${NUMERIC_DOT_PLACEHOLDER}$2`);

		let parts: string[];
		if (this.isJapanese(lang)) {
			// 日本語: 句読点で分割（句読点は前の文に含める）
			parts = this.splitWithDelimiter(protected_, JA_SENTENCE_BOUNDARY_REGEX);
		} else {
			// 英語・その他: ピリオド+空白+大文字で分割
			parts = this.splitWithDelimiter(protected_, EN_SENTENCE_BOUNDARY_REGEX);
		}

		// 数値内ドットを復元
		return parts.map((s) => s.replace(new RegExp(NUMERIC_DOT_PLACEHOLDER, "g"), "."));
	}

	/**
	 * 正規表現の区切り文字を含めて分割する。
	 * 区切り文字は直前の文に付加される。
	 */
	private splitWithDelimiter(text: string, regex: RegExp): string[] {
		const result: string[] = [];
		let lastIndex = 0;

		// 正規表現をリセット
		const re = new RegExp(regex.source, regex.flags);
		for (const match of text.matchAll(re)) {
			const delimiter = match[1]; // キャプチャグループ（句読点）
			const endOfSentence = match.index + delimiter.length;
			const sentence = text.substring(lastIndex, endOfSentence);
			if (sentence.trim()) {
				result.push(sentence.trim());
			}
			lastIndex = endOfSentence;
			// 区切り後の空白をスキップ
			const afterDelimiter = text.substring(endOfSentence);
			const leadingSpace = afterDelimiter.match(/^\s*/);
			if (leadingSpace && leadingSpace[0].length > 0) {
				lastIndex += leadingSpace[0].length;
			}
		}

		// 残りのテキスト
		const remaining = text.substring(lastIndex);
		if (remaining.trim()) {
			result.push(remaining.trim());
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

	/**
	 * 日本語かどうかを判定する。
	 */
	private isJapanese(lang: string): boolean {
		return lang.toLowerCase().startsWith("ja");
	}
}
