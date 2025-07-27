/**
 * mdaitMarkerクラス
 * mdaitUnitの前に配置されるmdaitメタデータコメントを表現する
 * @important このクラスはドメインオブジェクトです。変更時は理由を明示し、承認なしに編集しないでください。
 */
export class MdaitMarker {
	/**
	 * コンストラクタ
	 * @param hash ユニット本文のハッシュ
	 * @param from 翻訳元ユニットのハッシュ
	 * @param need 翻訳の必要性を表すタグ
	 */
	constructor(
		public hash: string,
		public from: string | null = null,
		public need: string | null = null,
	) {}
	/**
	 * コメントをMarkdown形式の文字列として出力
	 */
	toString(): string {
		let result = `<!-- mdait ${this.hash}`;

		if (this.from) {
			result += ` from:${this.from}`;
		}

		if (this.need) {
			result += ` need:${this.need}`;
		}

		result += " -->";
		return result;
	}
	/**
	 * MdaitMarker文字列からMdaitHeaderを生成
	 * @param commentText Markdownコメント文字列
	 * @returns MdaitHeaderオブジェクト、またはパース失敗時はnull
	 */
	static parse(commentText: string): MdaitMarker | null {
		// コメントテキストをサニタイズ（余分な空白や改行を削除）
		const sanitizedText = commentText.trim().replace(/\s+/g, " ");

		// MdaitMarkerのパターン
		const mdaitPattern = /<!-- mdait ([a-zA-Z0-9]+)(?:\s+from:([a-zA-Z0-9]+))?(?:\s+need:(\w+))?\s*-->/;
		const match = sanitizedText.match(mdaitPattern);

		if (!match) {
			return null;
		}

		const [, hash, from, needTag] = match;
		return new MdaitMarker(hash, from || null, needTag || null);
	}
	/**
	 * 指定されたhashとfromでコメントを生成
	 * @param hash ユニット本文のハッシュ
	 * @param from 翻訳元のユニットハッシュ
	 * @returns 新しいMdaitCommentオブジェクト
	 */
	static createWithTranslateTag(hash: string, from: string): MdaitMarker {
		return new MdaitMarker(hash, from, "translate");
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
		this.need = null;
	}

	/**
	 * needフラグを設定する
	 * @param need 設定するneedフラグ
	 */
	setNeed(need: string | null): void {
		this.need = need;
	}

	/**
	 * 翻訳が必要かどうか
	 */
	needsTranslation(): boolean {
		return this.need === "translate";
	}
}
