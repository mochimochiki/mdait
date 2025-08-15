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
	 * MdaitMarkerの正規表現パターン
	 */
	static readonly MARKER_REGEX = /<!-- mdait ([a-zA-Z0-9]+)(?:\s+from:([a-zA-Z0-9]+))?(?:\s+need:(\w+))?\s*-->/;

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
	 * @param markerText Markdownコメント文字列
	 * @returns MdaitHeaderオブジェクト、またはパース失敗時はnull
	 */
	static parse(markerText: string): MdaitMarker | null {
		// コメントテキストをサニタイズ（余分な空白や改行を削除）
		const sanitizedText = markerText.trim().replace(/\s+/g, " ");
		const match = sanitizedText.match(MdaitMarker.MARKER_REGEX);
		if (!match) {
			return null;
		}
		const [, hash, from, needTag] = match;
		return new MdaitMarker(hash, from || null, needTag || null);
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
