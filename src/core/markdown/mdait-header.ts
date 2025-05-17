/**
 * mdaitコメントクラス
 * Markdownセクションの前に配置されるmdaitメタデータコメントを表現する
 * @important このクラスはドメインオブジェクトです。変更時は理由を明示し、承認なしに編集しないでください。
 */
export class MdaitHeader {
	/**
	 * コンストラクタ
	 * @param hash セクション本文の短縮ハッシュ
	 * @param srcHash 翻訳元のセクションハッシュ (オプショナル)
	 * @param needTag 翻訳の必要性を表すタグ (オプショナル)
	 */
	constructor(
		public hash: string,
		public srcHash: string | null = null,
		public needTag: string | null = null,
	) {}

	/**
	 * コメントをMarkdown形式の文字列として出力
	 */
	toString(): string {
		let result = `<!-- mdait ${this.hash}`;

		if (this.srcHash) {
			result += ` src:${this.srcHash}`;
		}

		if (this.needTag) {
			result += ` need:${this.needTag}`;
		}

		result += " -->";
		return result;
	}

	/**
	 * Markdownコメント文字列からMdaitHeaderを生成
	 * @param commentText Markdownコメント文字列
	 * @returns MdaitHeaderオブジェクト、またはパース失敗時はnull
	 */
	static parse(commentText: string): MdaitHeader | null {
		// コメントテキストをサニタイズ（余分な空白や改行を削除）
		const sanitizedText = commentText.trim().replace(/\s+/g, " ");

		// mdaitコメントのパターン
		const mdaitPattern =
			/<!-- mdait ([a-zA-Z0-9]+)(?:\s+src:([a-zA-Z0-9]+))?(?:\s+need:(\w+))?\s*-->/;
		const match = sanitizedText.match(mdaitPattern);

		if (!match) {
			return null;
		}

		const [, hash, srcHash, needTag] = match;
		return new MdaitHeader(hash, srcHash || null, needTag || null);
	}

	/**
	 * 指定されたhashとsrcHashでコメントを生成
	 * @param hash セクション本文のハッシュ
	 * @param srcHash 翻訳元のセクションハッシュ
	 * @returns 新しいMdaitCommentオブジェクト
	 */
	static createWithTranslateTag(hash: string, srcHash: string): MdaitHeader {
		return new MdaitHeader(hash, srcHash, "translate");
	}

	/**
	 * コメントのハッシュを更新
	 * @param newHash 新しいハッシュ値
	 */
	updateHash(newHash: string): void {
		this.hash = newHash;
	}

	/**
	 * 翻訳必要タグを削除
	 */
	removeNeedTag(): void {
		this.needTag = null;
	}

	/**
	 * 翻訳が必要かどうか
	 */
	needsTranslation(): boolean {
		return this.needTag === "translate" || this.needTag === "review";
	}
}
