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
	 * @param fixed 確定フラグ
	 */
	constructor(
		public hash: string,
		public from: string | null = null,
		public need: string | null = null,
		public fixed = false,
	) {}

	/**
	 * MdaitMarkerの正規表現パターン
	 * ハッシュは省略可能（<!-- mdait --> のみも許容）
	 * needフィールドは revise@{hash} 形式もサポート
	 * fixedキーワードは末尾に配置される
	 */
	static readonly MARKER_REGEX =
		/<!-- mdait(?:\s+([a-zA-Z0-9]+))?(?:\s+from:([a-zA-Z0-9]+))?(?:\s+need:([\w@]+))?(\s+fixed)?\s*-->/;

	/**
	 * コメントをMarkdown形式の文字列として出力
	 */
	toString(): string {
		let result = "<!-- mdait";

		// ハッシュがある場合のみ出力
		if (this.hash) {
			result += ` ${this.hash}`;
		}

		if (this.from) {
			result += ` from:${this.from}`;
		}

		if (this.need) {
			result += ` need:${this.need}`;
		}

		if (this.fixed) {
			result += " fixed";
		}

		result += " -->";
		return result;
	}

	/**
	 * MdaitMarker文字列からMdaitMarkerを生成
	 * @param markerText Markdownコメント文字列
	 * @returns MdaitMarkerオブジェクト、またはパース失敗時はnull
	 */
	static parse(markerText: string): MdaitMarker | null {
		// コメントテキストをサニタイズ（余分な空白や改行を削除）
		const sanitizedText = markerText.trim().replace(/\s+/g, " ");
		const match = sanitizedText.match(MdaitMarker.MARKER_REGEX);
		if (!match) {
			return null;
		}
		const [, hash, from, needTag, fixedKeyword] = match;
		// ハッシュが省略された場合は空文字列とする
		const fixed = fixedKeyword !== undefined;
		return new MdaitMarker(hash || "", from || null, needTag || null, fixed);
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
		return this.need === "translate" || this.needsRevision();
	}

	/**
	 * 改訂が必要かどうか（revise@{hash}形式）
	 */
	needsRevision(): boolean {
		return this.need?.startsWith("revise@") ?? false;
	}

	/**
	 * revise@{hash}形式からoldhashを抽出
	 * @returns oldhash、revise形式でない場合はnull
	 */
	getOldHashFromNeed(): string | null {
		if (!this.need?.startsWith("revise@")) {
			return null;
		}
		return this.need.substring(7); // "revise@".length = 7
	}

	/**
	 * need:revise@{oldhash}形式を設定
	 * @param oldhash 旧ハッシュ値
	 */
	setReviseNeed(oldhash: string): void {
		this.need = `revise@${oldhash}`;
	}

	/**
	 * need文字列からoldhashを抽出する静的メソッド
	 * @param need need文字列
	 * @returns oldhash、revise形式でない場合はnull
	 */
	static extractOldHashFromNeed(need: string | null | undefined): string | null {
		if (!need?.startsWith("revise@")) {
			return null;
		}
		return need.substring(7); // "revise@".length = 7
	}

	/**
	 * 確定済みかどうかを返す
	 * @returns 確定済みであればtrue
	 */
	isFixed(): boolean {
		return this.fixed;
	}

	/**
	 * 確定フラグを設定する
	 * @param value 確定フラグの値
	 */
	setFixed(value: boolean): void {
		this.fixed = value;
	}
}
