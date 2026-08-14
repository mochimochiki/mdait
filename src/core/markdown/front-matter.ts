import matter from "gray-matter";

/**
 * フロントマターの値を格納する型
 */
export type FrontMatterData = {
	// biome-ignore lint/suspicious/noExplicitAny: フロントマターは任意の構造を持つ
	[key: string]: any;
};

/**
 * フロントマターを管理するクラス
 * dataとrawの両方の形式を統合的に扱い、編集時の同期を自動管理する
 */
export class FrontMatter {
	private _data: FrontMatterData;
	private _raw: string;
	/** mdait管理外のフィールドの元の文字列表現（フォーマット保持用） */
	private _nonMdaitRaw: string;
	/** set()で変更されたnon-mdaitトップレベルキー（これらは_dataから再生成される） */
	private _modifiedNonMdaitKeys: Set<string>;
	/**
	 * 置き場所が外部（`unit-state`）にあるキー（ドットパス）。
	 *
	 * `_data` には載せるが `_raw` には**一度も書かない**。読み手が `get()` で引ける形を
	 * 保ちながら、ファイルには出さないための区別である。`_updateRaw()` を通して消す形に
	 * すると、mdait 以外のキーの書式（空行の位置など）が再現されずに崩れる。
	 */
	private _externalKeys: Set<string>;

	/**
	 * フロントマターの開始行番号（0ベース、通常0）
	 */
	public readonly startLine: number;

	/**
	 * フロントマターの終了行番号（0ベース、閉じ---の行）
	 */
	public readonly endLine: number;

	/**
	 * コンストラクタ
	 * @param data フロントマターデータ
	 * @param raw フロントマターの生文字列（オプション）
	 * @param startLine 開始行番号（0ベース）
	 * @param endLine 終了行番号（0ベース）
	 * @param nonMdaitRaw mdait管理外のフィールドの元の文字列表現
	 */
	private constructor(
		data: FrontMatterData,
		raw: string,
		startLine = 0,
		endLine = 0,
		nonMdaitRaw = "",
		modifiedNonMdaitKeys?: Set<string>,
		externalKeys?: Set<string>,
	) {
		this._data = data;
		this._raw = raw;
		this.startLine = startLine;
		this.endLine = endLine;
		this._nonMdaitRaw = nonMdaitRaw;
		this._modifiedNonMdaitKeys = modifiedNonMdaitKeys ?? new Set();
		this._externalKeys = externalKeys ?? new Set();
	}

	/**
	 * Markdown文字列からFrontMatterを作成
	 * @param markdown Markdown文字列
	 * @returns FrontMatterインスタンスとフロントマター除去後のコンテンツ
	 */
	static parse(markdown: string): {
		frontMatter: FrontMatter | undefined;
		content: string;
		frontMatterLineOffset: number;
	} {
		// gray-matter は内容文字列をキーに parse 結果を溜め、同じ内容には同じ data の参照を返す
		// （返り値は浅いコピーなので data だけが共有される）。FrontMatter は _data を破壊的に
		// 書き換えるため、そのまま持つとキャッシュ側が書き換え後の値に汚染され、
		// 同じ内容のファイルを開き直しても前回の書き換え結果が返ってくる。
		// オプションを渡してキャッシュを使わせず、さらに data は自前の複製を持つ
		// （FrontMatter が _data の所有者であることを、gray-matter の実装に依存せず保証する）。
		const parsed = matter(markdown, {});
		const data = structuredClone(parsed.data) as FrontMatterData;
		const content = parsed.content;

		// フロントマターの生文字列を抽出
		let frontMatterRaw = "";
		let frontMatterLineOffset = 0;

		// content が空または空白のみの場合（フロントマターのみ）も正しく処理する
		// 注: stringifyが末尾に改行を追加するため、再パース時にcontentが"\n"になる場合がある
		if (content.trim().length === 0 && markdown.trim().length > 0) {
			// フロントマターのみの場合、markdown全体がfrontMatterRaw
			frontMatterRaw = markdown;
			frontMatterLineOffset = frontMatterRaw.split(/\r?\n/).length - 1;
		} else {
			const idx = markdown.indexOf(content);
			if (idx > 0) {
				frontMatterRaw = markdown.substring(0, idx);
				// フロントマターの行数を計算
				frontMatterLineOffset = frontMatterRaw.split(/\r?\n/).length - 1;
			}
		}

		// フロントマターが存在しない場合（構造自体がない場合）
		if (Object.keys(data).length === 0 && frontMatterRaw.length === 0) {
			return { frontMatter: undefined, content, frontMatterLineOffset: 0 };
		}

		// 開始行は0、終了行はfrontMatterLineOffset（閉じ---の行）
		const startLine = 0;
		const endLine = frontMatterLineOffset;

		// mdait管理外の部分を抽出
		const nonMdaitRaw = extractNonMdaitRaw(frontMatterRaw);

		return {
			frontMatter: new FrontMatter(data, frontMatterRaw, startLine, endLine, nonMdaitRaw),
			content,
			frontMatterLineOffset,
		};
	}

	/**
	 * 空のFrontMatterを作成
	 * @returns FrontMatterインスタンス
	 */
	static empty(): FrontMatter {
		return new FrontMatter({}, "");
	}

	/**
	 * データオブジェクトから新しいFrontMatterを作成
	 * @param data フロントマターデータ
	 * @returns FrontMatterインスタンス
	 */
	static fromData(data: FrontMatterData): FrontMatter {
		const raw = matter.stringify("", data).trim();
		return new FrontMatter(data, raw);
	}

	/**
	 * フロントマターデータを取得（読み取り専用）
	 */
	get data(): Readonly<FrontMatterData> {
		return this._data;
	}

	/**
	 * フロントマターの生文字列を取得（常に最新の状態）
	 */
	get raw(): string {
		return this._raw;
	}

	/**
	 * フロントマターが空かどうかを判定
	 */
	isEmpty(): boolean {
		return Object.keys(this._data).length === 0;
	}

	/**
	 * Get the value of the specified key
	 * Supports dot path like "mdait.sync.level"
	 * @param key Key name or dot path
	 * @returns Value (undefined if not exists)
	 */
	// biome-ignore lint/suspicious/noExplicitAny: フロントマターの値は任意の型を持つ
	get<T = any>(key: string): T | undefined {
		const keys = key.split(".").filter((k) => k.length > 0);
		if (keys.length === 0) {
			return undefined;
		}

		// biome-ignore lint/suspicious/noExplicitAny: フロントマターは任意の階層構造を持つ
		let current: any = this._data;
		for (const k of keys) {
			if (current === null || current === undefined || typeof current !== "object") {
				return undefined;
			}
			current = current[k];
		}

		return current as T;
	}

	/**
	 * Set the value of the specified key
	 * Supports dot path like "mdait.sync.level"
	 * Creates nested objects as needed
	 * @param key Key name or dot path
	 * @param value Value to set
	 * @throws Error if key path is invalid or conflicts with existing non-object value
	 */
	// biome-ignore lint/suspicious/noExplicitAny: フロントマターの値は任意の型を持つ
	set(key: string, value: any): void {
		const keys = key.split(".").filter((k) => k.length > 0);
		if (keys.length === 0) {
			throw new Error("Invalid key: empty key path");
		}

		const topLevelKey = keys[0];
		if (keys.length === 1) {
			this._data[key] = value;
		} else {
			// biome-ignore lint/suspicious/noExplicitAny: フロントマターは任意の階層構造を持つ
			let current: any = this._data;
			for (let i = 0; i < keys.length - 1; i++) {
				const k = keys[i];
				const existing = current[k];

				// Check if existing value conflicts with nested path
				if (k in current) {
					if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
						throw new Error(`Cannot set nested property: "${k}" already exists as non-object value`);
					}
				} else {
					current[k] = {};
				}
				current = current[k];
			}
			current[keys[keys.length - 1]] = value;
		}

		// mdait以外のトップレベルキーが変更された場合、記録する
		if (topLevelKey !== "mdait") {
			this._modifiedNonMdaitKeys.add(topLevelKey);
		}

		// 置き場所が外部のキーは _raw に出ないので、作り直す理由が無い。
		// 作り直すと mdait 以外のキーの書式（空行の位置）が再現されず、
		// 「マーカーは書いていないのに原文が変わった」という形の書き換えになる
		if (!this._externalKeys.has(key)) {
			this._updateRaw();
		}
	}

	/**
	 * 複数のキーと値を一括設定
	 * @param updates 更新するキーと値のマップ
	 */
	// biome-ignore lint/suspicious/noExplicitAny: フロントマターの値は任意の型を持つ
	setMultiple(updates: Record<string, any>): void {
		for (const [key, value] of Object.entries(updates)) {
			const keys = key.split(".").filter((k) => k.length > 0);
			if (keys.length === 0) {
				continue;
			}

			if (keys.length === 1) {
				this._data[key] = value;
			} else {
				// biome-ignore lint/suspicious/noExplicitAny: フロントマターは任意の階層構造を持つ
				let current: any = this._data;
				for (let i = 0; i < keys.length - 1; i++) {
					const k = keys[i];
					if (!(k in current) || typeof current[k] !== "object" || current[k] === null) {
						current[k] = {};
					}
					current = current[k];
				}
				current[keys[keys.length - 1]] = value;
			}
		}
		this._updateRaw();
	}

	/**
	 * Delete the specified key
	 * Supports dot path like "mdait.sync.level"
	 * Automatically cleans up empty parent objects
	 * @param key Key name or dot path
	 */
	delete(key: string): void {
		const keys = key.split(".").filter((k) => k.length > 0);
		if (keys.length === 0) {
			return;
		}

		if (keys.length === 1) {
			delete this._data[key];
		} else {
			// biome-ignore lint/suspicious/noExplicitAny: フロントマターは任意の階層構造を持つ
			const path: any[] = [this._data];
			// biome-ignore lint/suspicious/noExplicitAny: フロントマターは任意の階層構造を持つ
			let current: any = this._data;

			// Navigate to the target, remembering each level
			for (let i = 0; i < keys.length - 1; i++) {
				if (!(keys[i] in current) || typeof current[keys[i]] !== "object") {
					return; // Path doesn't exist
				}
				current = current[keys[i]];
				path.push(current);
			}

			// Delete the final key
			delete current[keys[keys.length - 1]];

			// Clean up empty parent objects recursively
			for (let i = keys.length - 2; i >= 0; i--) {
				const parent = path[i];
				const childKey = keys[i];
				const child = parent[childKey];

				if (typeof child === "object" && child !== null && !Array.isArray(child) && Object.keys(child).length === 0) {
					delete parent[childKey];
				} else {
					break; // Stop if we encounter non-empty object
				}
			}
		}

		if (!this._externalKeys.has(key)) {
			this._updateRaw();
		}
	}

	/**
	 * このキーの置き場所は外部（`unit-state`）だと記録する。
	 *
	 * 以後 `_raw` を作り直すときにこのキーは書き出されない。値を載せる前に呼んでおく
	 * 必要がある — 載せてから別の `set()` が走ると、その時点で `_raw` へ漏れる。
	 *
	 * @param key ドットパス（例: "mdait.front"）
	 */
	markExternalKey(key: string): void {
		if (key.length > 0) {
			this._externalKeys.add(key);
		}
	}

	/**
	 * このキーの置き場所を「外部」から戻す（embedded へ書き戻すとき）。
	 *
	 * 印が付いたままだと `_raw` を作り直してもこのキーは書き出されず、**黙って消える**。
	 * 値が `_data` に載っているなら、その場で `_raw` を作り直して本文側の表現に戻す。
	 *
	 * @param key ドットパス（例: "mdait.front"）
	 */
	unmarkExternalKey(key: string): void {
		if (!this._externalKeys.delete(key)) {
			return;
		}
		if (this.has(key)) {
			this._updateRaw();
		}
	}

	/**
	 * 外部ストア由来の値を `_data` にだけ載せる（`_raw` は触らない）。
	 *
	 * external マーカーでは frontmatter マーカーの置き場所は `unit-state` であり、
	 * ファイルの frontmatter には現れてはならない。それでも `_data` に載せるのは、
	 * 読み手（ツリー・CodeLens・need の解決）が `get()` でマーカーを引くためである。
	 *
	 * @param key ドットパス（例: "mdait.front"）
	 * @param value 載せる値
	 */
	attachExternalValue(key: string, value: string): void {
		const keys = key.split(".").filter((k) => k.length > 0);
		if (keys.length === 0) {
			return;
		}
		this.markExternalKey(key);
		// biome-ignore lint/suspicious/noExplicitAny: フロントマターは任意の階層構造を持つ
		let current: any = this._data;
		for (let i = 0; i < keys.length - 1; i++) {
			const k = keys[i];
			const existing = current[k];
			if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
				current[k] = {};
			}
			current = current[k];
		}
		current[keys[keys.length - 1]] = value;
	}

	/**
	 * 外部へ持ち出したキーを `_raw` から取り除く。**`_data` には残す。**
	 *
	 * 残すのは2つの理由による。(1) 同じ文書を2度書き出す経路がある（翻訳の後始末など）。
	 * 消してしまうと2度目に「マーカーが無い」と読まれ、外部ストアの行がそのまま消える。
	 * (2) 書き出したあとに frontmatter を読む側（ステータス収集など）が、モードによって
	 * 見えたり見えなかったりする状態を作らない。ユニット側の `detachMarkers` も
	 * `unit.marker` を残しており、それに揃える。
	 *
	 * `_raw` に現れるのは、**ファイルにマーカーが書かれたまま残っている**ワークスペース
	 * （external へ移る前から在るもの）だけである。作り直すのではなく行を消すのは、
	 * 他のキーの書式を1バイトも動かさないため。
	 *
	 * @param key ドットパス（例: "mdait.front"）
	 */
	stripExternalValueFromRaw(key: string): void {
		const keys = key.split(".").filter((k) => k.length > 0);
		if (keys.length === 0) {
			return;
		}
		this.markExternalKey(key);
		this._removeNestedKeyFromRaw(keys);
	}

	/**
	 * `_raw` から、指定したドットパスのキーの行を取り除く（他の行は1バイトも動かさない）。
	 *
	 * 末尾のキー名だけで探すと無関係なトップレベルキーの下の同名キーに当たるので、
	 * 先頭のキーのブロックに入ってから探す。取り除いた結果その親が空になるなら
	 * 親の行も落とす（`mdait:` だけが残った状態を作らない）。
	 */
	private _removeNestedKeyFromRaw(keys: string[]): void {
		if (!this._raw || keys.length < 2) {
			return;
		}
		const [top] = keys;
		const leaf = keys[keys.length - 1];
		const lines = this._raw.split(/\r?\n/);
		const kept: string[] = [];
		let topLineIndex = -1;
		let topChildCount = 0;
		let inTop = false;
		let removed = false;
		for (const line of lines) {
			const indent = line.search(/\S/);
			const trimmed = line.trim();
			if (indent === 0 && trimmed !== "" && trimmed !== "---") {
				inTop = trimmed.startsWith(`${top}:`);
				if (inTop) {
					topLineIndex = kept.length;
					topChildCount = 0;
				}
				kept.push(line);
				continue;
			}
			if (inTop && indent > 0) {
				if (!removed && new RegExp(`^${leaf}\\s*:`).test(trimmed)) {
					removed = true;
					continue;
				}
				topChildCount++;
			}
			kept.push(line);
		}
		if (!removed) {
			return;
		}
		// 子が1つも残らなかった親（`mdait:` だけの行）は落とす
		if (topLineIndex >= 0 && topChildCount === 0) {
			kept.splice(topLineIndex, 1);
		}
		this._raw = kept.join("\n");
	}

	/**
	 * すべてのキーを取得
	 * @returns キーの配列
	 */
	keys(): string[] {
		return Object.keys(this._data);
	}

	/**
	 * Check if the specified key exists
	 * Supports dot path like "mdait.sync.level"
	 * @param key Key name or dot path
	 * @returns true if exists
	 */
	has(key: string): boolean {
		const keys = key.split(".").filter((k) => k.length > 0);
		if (keys.length === 0) {
			return false;
		}

		// biome-ignore lint/suspicious/noExplicitAny: フロントマターは任意の階層構造を持つ
		let current: any = this._data;
		for (const k of keys) {
			if (current === null || current === undefined || typeof current !== "object") {
				return false;
			}
			if (!(k in current)) {
				return false;
			}
			current = current[k];
		}

		return true;
	}

	/**
	 * フロントマターをMarkdown形式で文字列化
	 * @returns Markdown形式の文字列
	 */
	stringify(): string {
		return this._raw;
	}

	/**
	 * _raw を _data と整合させる。
	 * set() を経由せず _data のマーカーが変化した場合など、_raw が古くなるケースの保険。
	 * 出力（stringify）直前に呼ぶことで、_data を正としたシリアライズを保証する。
	 *
	 * ただし _updateRaw() は非mdaitキーの元フォーマット（空行など）を完全には再現できないため、
	 * mdait セクションの有無（存在）が _data と _raw で食い違うときだけ再生成する
	 * （不要な再フォーマットを避ける。マーカー値そのものの差分は set() 経由で常に整合するため対象外）。
	 */
	reconcileRaw(): void {
		const hasMarkerInData = Object.keys(this._mdaitForRaw()).length > 0;
		const hasMarkerInRaw = /(^|\n)\s*mdait:/.test(this._raw);
		if (hasMarkerInData !== hasMarkerInRaw) {
			this._updateRaw();
		}
	}

	/**
	 * `_raw` に書き出すべき mdait 部分（置き場所が外部のキーを除いたもの）。
	 *
	 * 除いた結果 `mdait` が空になるなら、`mdait:` という見出しごと出さない。
	 */
	private _mdaitForRaw(): FrontMatterData {
		const { mdait } = separateMdaitData(this._data);
		if (this._externalKeys.size === 0 || Object.keys(mdait).length === 0) {
			return mdait;
		}
		const copy = structuredClone(mdait) as FrontMatterData;
		for (const key of this._externalKeys) {
			const keys = key.split(".").filter((k) => k.length > 0);
			// biome-ignore lint/suspicious/noExplicitAny: フロントマターは任意の階層構造を持つ
			const path: any[] = [copy];
			// biome-ignore lint/suspicious/noExplicitAny: フロントマターは任意の階層構造を持つ
			let current: any = copy;
			let reachable = true;
			for (let i = 0; i < keys.length - 1; i++) {
				const next = current[keys[i]];
				if (typeof next !== "object" || next === null) {
					reachable = false;
					break;
				}
				current = next;
				path.push(current);
			}
			if (!reachable) {
				continue;
			}
			delete current[keys[keys.length - 1]];
			// 空になった親を畳む（`mdait: {}` を出さない）
			for (let i = keys.length - 2; i >= 0; i--) {
				const parent = path[i];
				const child = parent[keys[i]];
				if (typeof child === "object" && child !== null && !Array.isArray(child) && Object.keys(child).length === 0) {
					delete parent[keys[i]];
				} else {
					break;
				}
			}
		}
		return copy;
	}

	/**
	 * Update raw string from data changes
	 * Regenerates mdait portion and modified non-mdait keys from _data,
	 * while preserving original format for unmodified non-mdait keys
	 */
	private _updateRaw(): void {
		if (Object.keys(this._data).length === 0) {
			this._raw = "";
			return;
		}

		// mdait部分とnon-mdait部分を分離。置き場所が外部のキーは _raw に書かない
		const { nonMdait } = separateMdaitData(this._data);
		const mdait = this._mdaitForRaw();

		// mdait部分が空でnon-mdait部分もない場合
		if (Object.keys(mdait).length === 0 && Object.keys(nonMdait).length === 0) {
			this._raw = "";
			return;
		}

		// mdait部分を再生成
		const mdaitRaw = Object.keys(mdait).length > 0 ? matter.stringify("", mdait).trim() : "";

		// non-mdait部分の処理：
		// 1. 変更されていないキーは元のフォーマットを保持（_nonMdaitRawから抽出）
		// 2. 変更されたキーは元の位置で値のみ置換
		let nonMdaitRaw = "";
		if (Object.keys(nonMdait).length > 0) {
			if (this._nonMdaitRaw && this._modifiedNonMdaitKeys.size > 0) {
				// 変更されたキーの新しい値を取得
				const modifiedValues: Record<string, unknown> = {};
				for (const key of this._modifiedNonMdaitKeys) {
					if (key in nonMdait) {
						modifiedValues[key] = nonMdait[key];
					}
				}
				// 元のraw文字列内で変更されたキーの値を置換
				nonMdaitRaw = replaceKeysInRaw(this._nonMdaitRaw, modifiedValues);
			} else if (this._nonMdaitRaw) {
				// 変更がない場合は元のフォーマットをそのまま使用
				nonMdaitRaw = this._nonMdaitRaw;
			} else {
				// 元のrawがない場合は全て再生成
				nonMdaitRaw = matter.stringify("", nonMdait).trim();
			}
		}

		// 全体を結合
		this._raw = mergeFrontmatterParts(nonMdaitRaw, mdaitRaw);

		// 次回のために非mdait部分を更新
		if (Object.keys(nonMdait).length > 0) {
			// _nonMdaitRawは元のフォーマットを維持するため、初期化時のみ設定
			if (!this._nonMdaitRaw) {
				this._nonMdaitRaw = extractNonMdaitRaw(this._raw);
			}
		} else {
			this._nonMdaitRaw = "";
		}
	}

	/**
	 * FrontMatterのクローンを作成
	 * @returns 新しいFrontMatterインスタンス
	 */
	clone(): FrontMatter {
		// structuredCloneで深いクローンを行い、ネストされたオブジェクトの参照共有を防ぐ
		const clonedData = structuredClone(this._data);
		return new FrontMatter(
			clonedData,
			this._raw,
			this.startLine,
			this.endLine,
			this._nonMdaitRaw,
			new Set(this._modifiedNonMdaitKeys),
			new Set(this._externalKeys),
		);
	}
}

/**
 * frontmatterのrawからmdait管理外の部分を抽出
 */
function extractNonMdaitRaw(raw: string): string {
	if (!raw) {
		return "";
	}

	// frontmatterの区切り文字を除去
	const lines = raw.split(/\r?\n/);
	const contentLines = lines.filter((line) => line.trim() !== "---");

	// mdaitセクションを検出して除去
	const result: string[] = [];
	let inMdaitSection = false;
	let mdaitIndentLevel = -1;

	for (const line of contentLines) {
		// インデントレベルを計算
		const indent = line.search(/\S/);
		const trimmed = line.trim();

		// mdaitセクションの開始を検出
		if (indent === 0 && trimmed.startsWith("mdait:")) {
			inMdaitSection = true;
			mdaitIndentLevel = 0;
			continue;
		}

		// mdaitセクション内かどうかを判定
		if (inMdaitSection) {
			// 同じまたはより深いインデントなら、まだmdaitセクション内
			if (indent > mdaitIndentLevel || trimmed === "") {
				continue;
			}
			// インデントが浅くなったら、mdaitセクション終了
			inMdaitSection = false;
		}

		// mdaitセクション外の行を保持
		if (!inMdaitSection) {
			result.push(line);
		}
	}

	return result.join("\n");
}

/**
 * データオブジェクトをmdait部分とnon-mdait部分に分離
 */
function separateMdaitData(data: FrontMatterData): { mdait: FrontMatterData; nonMdait: FrontMatterData } {
	const mdait: FrontMatterData = {};
	const nonMdait: FrontMatterData = {};

	for (const [key, value] of Object.entries(data)) {
		if (key === "mdait") {
			mdait[key] = value;
		} else {
			nonMdait[key] = value;
		}
	}

	return { mdait, nonMdait };
}

/**
 * non-mdait部分とmdait部分を結合してfrontmatter文字列を生成
 */
function mergeFrontmatterParts(nonMdaitRaw: string, mdaitRaw: string): string {
	// 両方が空の場合
	if (!nonMdaitRaw && !mdaitRaw) {
		return "";
	}

	// mdaitのみの場合
	if (!nonMdaitRaw) {
		return mdaitRaw;
	}

	// non-mdaitのみの場合
	if (!mdaitRaw) {
		// 区切り文字を含む完全なフォーマットに変換
		if (nonMdaitRaw.startsWith("---")) {
			return nonMdaitRaw;
		}
		return `---\n${nonMdaitRaw}\n---`;
	}

	// 両方ある場合は結合
	// nonMdaitRawから区切り文字を除去してコンテンツ部分のみを取得
	const nonMdaitLines = nonMdaitRaw.split(/\r?\n/).filter((line) => line.trim() !== "---");
	const mdaitLines = mdaitRaw.split(/\r?\n/).filter((line) => line.trim() !== "---");

	// 末尾の空行を除去
	while (nonMdaitLines.length > 0 && nonMdaitLines[nonMdaitLines.length - 1].trim() === "") {
		nonMdaitLines.pop();
	}

	// 結合
	const combined = [...nonMdaitLines, ...mdaitLines];
	return `---\n${combined.join("\n")}\n---`;
}

/**
 * raw文字列内の指定されたキーの値を新しい値で置換（元の位置を維持）
 * @param raw 元のraw文字列（区切り文字なし）
 * @param newValues 置換するキーと新しい値のマップ
 * @returns 値が置換されたraw文字列
 */
function replaceKeysInRaw(raw: string, newValues: Record<string, unknown>): string {
	if (!raw || Object.keys(newValues).length === 0) {
		return raw;
	}

	const lines = raw.split(/\r?\n/);
	const result: string[] = [];
	let currentKey: string | null = null;
	let skipNestedLines = false;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const indent = line.search(/\S/);
		const trimmed = line.trim();

		// 空行の処理
		if (trimmed === "") {
			if (!skipNestedLines) {
				result.push(line);
			}
			continue;
		}

		// トップレベルキー（インデントなし）を検出
		if (indent === 0) {
			const colonIdx = trimmed.indexOf(":");
			if (colonIdx > 0) {
				const keyName = trimmed.substring(0, colonIdx);

				if (keyName in newValues) {
					// このキーの値を置換
					currentKey = keyName;
					const newValue = newValues[keyName];

					// 単純な値（文字列、数値、ブール）の場合は1行で置換
					if (typeof newValue === "string" || typeof newValue === "number" || typeof newValue === "boolean") {
						result.push(`${keyName}: ${formatSimpleValue(newValue)}`);
						skipNestedLines = true;
					} else {
						// 複雑な値（オブジェクト、配列）の場合はgray-matterで生成
						const generated = matter.stringify("", { [keyName]: newValue }).trim();
						const generatedLines = generated.split(/\r?\n/).filter((l) => l.trim() !== "---");
						result.push(...generatedLines);
						skipNestedLines = true;
					}
					continue;
				}
				// 新しいトップレベルキーが始まったのでスキップ終了
				currentKey = null;
				skipNestedLines = false;
			}
		}

		// スキップ中（置換したキーのネストされた行）
		if (skipNestedLines && indent > 0) {
			continue;
		}

		// インデントが0に戻ったらスキップ終了
		if (skipNestedLines && indent === 0) {
			skipNestedLines = false;
		}

		if (!skipNestedLines) {
			result.push(line);
		}
	}

	return result.join("\n");
}

/**
 * 単純な値をYAML形式でフォーマット
 */
function formatSimpleValue(value: string | number | boolean): string {
	if (typeof value === "string") {
		// 特殊文字を含む場合はクォート
		if (
			value.includes(":") ||
			value.includes("#") ||
			value.includes("'") ||
			value.includes('"') ||
			value.includes("\n")
		) {
			// シングルクォート内のシングルクォートはエスケープ
			if (value.includes("'")) {
				return `"${value.replace(/"/g, '\\"')}"`;
			}
			return `'${value}'`;
		}
		return value;
	}
	return String(value);
}
