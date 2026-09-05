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
	 * ハッシュは省略可能（<!-- mdait --> のみも許容）
	 * needフィールドは revise@{hash} 形式もサポート
	 * needの文字クラスにはハイフンを含む（verify-deletion などの既定語彙のため。
	 * 従来の [\w@]+ では need:verify-deletion がパース不能で往復消失するバグがあった）
	 */
	static readonly MARKER_REGEX =
		/<!-- mdait(?:\s+([a-zA-Z0-9]+))?(?:\s+from:([a-zA-Z0-9]+))?(?:\s+need:([\w@-]+))?\s*-->/;

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
		const [, hash, from, needTag] = match;
		// ハッシュが省略された場合は空文字列とする
		return new MdaitMarker(hash || "", from || null, needTag || null);
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
	 * 翻訳待ちのまま本文が書き換えられている（＝人が手で訳したが未確定）か。
	 *
	 * sync 直後の訳文は原文のコピーなので `hash === from`。need:translate が残ったまま
	 * 本文ハッシュだけが動いていれば、AI 翻訳（完了時に need を落とす）ではなく人の編集である。
	 *
	 * **この判定は「未訳の訳文はいまの原文の丸写しである」という不変条件に乗っている。**
	 * かつて sync は原文が変わっても丸写しを写し直さず `from` だけ進めていたため、
	 * 人が一度も触っていないユニットが「編集済み」を名乗っていた（ADR-260905-02）。
	 * 不変条件は sync が保つ（`sync-command.ts` の `refreshUntranslatedCopy`）。
	 * ここを広げる前に、その前提がまだ成り立っているかを先に確かめること。
	 *
	 * **`revise@X` はここでは判定しない。** X は「改訂が要求された時点の訳文ハッシュ」ではなく
	 * **旧原文のハッシュ**（`marker-sync.ts` の `setReviseNeed(oldSourceHash)`）であり、
	 * 訳文テキストのハッシュと比べても意味を持たない（別の名前空間の値なので実質つねに不一致になり、
	 * 訳文に一度も触れていないユニットまで「編集済み」と表示していた）。原文が変わったことは
	 * `needsRevise()` が表し、状態表示はそちらが担う（ADR-260802-03）。
	 *
	 * 「本文が原文と同一のまま訳し終えた」ケース（固有名詞の見出しなど）は編集と
	 * 見なせないが、そこで案内を出さないのは害がない（確定ボタンは常に隣にある）。
	 */
	hasUnconfirmedEdit(): boolean {
		if (!this.hash) {
			return false;
		}
		if (this.need === "translate") {
			return this.from !== null && this.hash !== this.from;
		}
		return false;
	}
}
