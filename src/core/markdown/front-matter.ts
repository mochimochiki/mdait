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
	private constructor(data: FrontMatterData, raw: string, startLine = 0, endLine = 0, nonMdaitRaw = "") {
		this._data = data;
		this._raw = raw;
		this.startLine = startLine;
		this.endLine = endLine;
		this._nonMdaitRaw = nonMdaitRaw;
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
	 * Regenerates only the mdait portion and merges with non-mdait portion
	 */
	private _updateRaw(): void {
		if (Object.keys(this._data).length === 0) {
			this._raw = "";
			return;
		}

		// mdait部分とnon-mdait部分を分離してマージ
		const { mdait, nonMdait } = separateMdaitData(this._data);

		// mdait部分が空でnon-mdait部分もない場合
		if (Object.keys(mdait).length === 0 && Object.keys(nonMdait).length === 0) {
			this._raw = "";
			return;
		}

		// mdait部分を再生成
		const mdaitRaw = Object.keys(mdait).length > 0 ? matter.stringify("", mdait).trim() : "";

		// non-mdait部分は元のフォーマットを使用、なければgray-matterで生成
		let nonMdaitRaw = this._nonMdaitRaw;
		if (!nonMdaitRaw && Object.keys(nonMdait).length > 0) {
			nonMdaitRaw = matter.stringify("", nonMdait).trim();
		}

		// 両方を結合
		this._raw = mergeFrontmatterParts(nonMdaitRaw, mdaitRaw);

		// 次回のために非mdait部分を更新
		if (Object.keys(nonMdait).length > 0) {
			// _nonMdaitRawは元のフォーマットを維持するため、更新しない
			// 新しくnon-mdaitフィールドが追加された場合のみ更新
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
		return new FrontMatter({ ...this._data }, this._raw, this.startLine, this.endLine, this._nonMdaitRaw);
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
