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
	 */
	private constructor(data: FrontMatterData, raw: string, startLine = 0, endLine = 0) {
		this._data = data;
		this._raw = raw;
		this.startLine = startLine;
		this.endLine = endLine;
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
		const parsed = matter(markdown);
		const data = parsed.data as FrontMatterData;
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

		return {
			frontMatter: new FrontMatter(data, frontMatterRaw, startLine, endLine),
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

		this._updateRaw();
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

		this._updateRaw();
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
	 * Update raw string from data changes
	 * Always regenerates the entire frontmatter using gray-matter
	 */
	private _updateRaw(): void {
		if (Object.keys(this._data).length === 0) {
			this._raw = "";
			return;
		}

		this._raw = matter.stringify("", this._data).trim();
	}

	/**
	 * FrontMatterのクローンを作成
	 * @returns 新しいFrontMatterインスタンス
	 */
	clone(): FrontMatter {
		return new FrontMatter({ ...this._data }, this._raw, this.startLine, this.endLine);
	}
}
