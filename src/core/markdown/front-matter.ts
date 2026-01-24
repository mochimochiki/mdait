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
	// biome-ignore lint/suspicious/noExplicitAny: フロントマターの値は任意の型を持つ
	private _pendingChanges: Map<string, { type: "set" | "delete"; value?: any }>;

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
		this._pendingChanges = new Map();
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
	 * 指定したキーの値を取得
	 * @param key キー名
	 * @returns 値（存在しない場合はundefined）
	 */
	// biome-ignore lint/suspicious/noExplicitAny: フロントマターの値は任意の型を持つ
	get<T = any>(key: string): T | undefined {
		return this._data[key];
	}

	/**
	 * 指定したキーの値を設定
	 * 内部でrawも自動更新される
	 * @param key キー名
	 * @param value 設定する値
	 */
	// biome-ignore lint/suspicious/noExplicitAny: フロントマターの値は任意の型を持つ
	set(key: string, value: any): void {
		this._data[key] = value;
		this._pendingChanges.set(key, { type: "set", value });
		this._updateRaw();
	}

	/**
	 * 複数のキーと値を一括設定
	 * @param updates 更新するキーと値のマップ
	 */
	// biome-ignore lint/suspicious/noExplicitAny: フロントマターの値は任意の型を持つ
	setMultiple(updates: Record<string, any>): void {
		for (const [key, value] of Object.entries(updates)) {
			this._data[key] = value;
			this._pendingChanges.set(key, { type: "set", value });
		}
		this._updateRaw();
	}

	/**
	 * 指定したキーを削除
	 * @param key キー名
	 */
	delete(key: string): void {
		delete this._data[key];
		this._pendingChanges.set(key, { type: "delete" });
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
	 * 指定したキーが存在するか確認
	 * @param key キー名
	 * @returns 存在する場合はtrue
	 */
	has(key: string): boolean {
		return key in this._data;
	}

	/**
	 * フロントマターをMarkdown形式で文字列化
	 * @returns Markdown形式の文字列
	 */
	stringify(): string {
		return this._raw;
	}

	/**
	 * 内部でdataの変更をrawに反映
	 * 変更されたキーの値部分のみを置換し、元の形式を最大限保持する
	 */
	private _updateRaw(): void {
		if (Object.keys(this._data).length === 0) {
			this._raw = "";
			this._pendingChanges.clear();
			return;
		}

		// 初回または元のrawがない場合は、新規生成
		if (!this._raw || this._raw.trim().length === 0) {
			this._raw = matter.stringify("", this._data).trim();
			this._pendingChanges.clear();
			return;
		}

		// 変更がない場合は何もしない
		if (this._pendingChanges.size === 0) {
			return;
		}

		// gray-matterで現在のrawをパースして、元の構造を理解
		const parsed = matter(this._raw);
		const originalData = parsed.data as FrontMatterData;

		let updatedRaw = this._raw;

		// 各変更について処理
		for (const [key, change] of this._pendingChanges) {
			if (change.type === "delete") {
				// キーの削除：該当行を削除
				updatedRaw = this._deleteKeyFromRaw(updatedRaw, key, originalData);
			} else if (change.type === "set") {
				// キーの設定：該当行の値を置換、または新規追加
				if (key in originalData) {
					// 既存キーの値を更新
					updatedRaw = this._replaceValueInRaw(updatedRaw, key, change.value, originalData);
				} else {
					// 新規キーを追加
					updatedRaw = this._addKeyToRaw(updatedRaw, key, change.value);
				}
			}
		}

		this._raw = updatedRaw;
		this._pendingChanges.clear();
	}

	/**
	 * raw文字列から指定キーの行を削除
	 */
	private _deleteKeyFromRaw(raw: string, key: string, originalData: FrontMatterData): string {
		// キーがもともと存在しない場合は何もしない
		if (!(key in originalData)) {
			return raw;
		}

		// キーに対応する行を検索して削除
		// gray-matterの出力形式に基づいて検索
		const keyPattern = `${key}:`;
		const lines = raw.split("\n");
		const updatedLines: string[] = [];
		let skipUntilIndentLevel: number | null = null;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];

			// スキップ中の場合、インデントをチェック
			if (skipUntilIndentLevel !== null) {
				const indentMatch = line.match(/^(\s*)/);
				const indent = indentMatch ? indentMatch[1].length : 0;
				const trimmed = line.trim();

				// 終了デリミタまたはインデントが同じかそれ以下なら、スキップ終了
				if (trimmed === "---" || (trimmed.length > 0 && indent <= skipUntilIndentLevel)) {
					skipUntilIndentLevel = null;
					updatedLines.push(line);
				}
				// スキップ中なので行を追加しない
				continue;
			}

			// キーに一致する行を検索
			const trimmed = line.trim();
			if (trimmed.startsWith(keyPattern)) {
				// この行のインデントレベルを記憶
				const indentMatch = line.match(/^(\s*)/);
				const indent = indentMatch ? indentMatch[1].length : 0;

				// オブジェクトや配列の場合、複数行をスキップ
				const valueMatch = line.match(/:\s*(.*)$/);
				if (valueMatch && valueMatch[1].trim().length === 0) {
					// 値が空 = 次の行から複数行の値が続く
					skipUntilIndentLevel = indent;
				}
				// この行を追加しない（削除）
				continue;
			}

			updatedLines.push(line);
		}

		return updatedLines.join("\n");
	}

	/**
	 * raw文字列内の指定キーの値を置換
	 */
	// biome-ignore lint/suspicious/noExplicitAny: フロントマターの値は任意の型を持つ
	private _replaceValueInRaw(raw: string, key: string, newValue: any, originalData: FrontMatterData): string {
		const keyPattern = `${key}:`;
		const lines = raw.split("\n");
		const updatedLines: string[] = [];
		let replaced = false;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const trimmed = line.trim();

			// キーに一致する行を検索
			if (!replaced && trimmed.startsWith(keyPattern)) {
				// この行のインデント、スペーシング、コメントを保持
				const match = line.match(/^(\s*)([^:]+):(\s*)(.*)$/);
				if (match) {
					const indent = match[1];
					const spacingAfterColon = match[3];
					const restOfLine = match[4];

					// 元の値と引用符スタイルを検出
					let quoteStyle: "single" | "double" | "none" = "none";
					const trimmedValue = restOfLine.trim();
					if (trimmedValue.match(/^'/)) {
						quoteStyle = "single";
					} else if (trimmedValue.match(/^"/)) {
						quoteStyle = "double";
					}

					// 行末コメントを保持
					const commentMatch = restOfLine.match(/^([^#]*?)(#.*)$/);
					let comment = "";
					if (commentMatch?.[2]) {
						comment = ` ${commentMatch[2]}`;
					}

					// オブジェクトや配列の場合は複数行を扱う必要があるため、
					// 簡単な値（文字列、数値、真偽値）のみ置換
					if (typeof newValue === "object" && newValue !== null) {
						// 複雑な値は置換しない（元の行を保持）
						updatedLines.push(line);
					} else {
						// 新しい値をフォーマット
						const formattedValue = this._toYamlValue(newValue, quoteStyle);
						updatedLines.push(`${indent}${key}:${spacingAfterColon}${formattedValue}${comment}`);
					}

					replaced = true;
					continue;
				}
			}

			updatedLines.push(line);
		}

		return updatedLines.join("\n");
	}

	/**
	 * raw文字列に新しいキーを追加
	 */
	// biome-ignore lint/suspicious/noExplicitAny: フロントマターの値は任意の型を持つ
	private _addKeyToRaw(raw: string, key: string, value: any): string {
		const lines = raw.split("\n");
		const updatedLines: string[] = [];
		let added = false;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const trimmed = line.trim();

			// 終了デリミタの前に新しいキーを追加
			if (!added && trimmed === "---" && i > 0) {
				const yamlValue = this._toYamlValue(value);
				updatedLines.push(`${key}: ${yamlValue}`);
				added = true;
			}

			updatedLines.push(line);
		}

		return updatedLines.join("\n");
	}

	/**
	 * 値を簡易YAML形式に変換
	 * @param value 変換する値
	 * @param quoteStyle 引用符のスタイル（元の形式を保持する場合に指定）
	 */
	// biome-ignore lint/suspicious/noExplicitAny: フロントマターの値は任意の型を持つ
	private _toYamlValue(value: any, quoteStyle: "single" | "double" | "none" = "none"): string {
		if (value === null || value === undefined) {
			return "";
		}
		if (typeof value === "string") {
			// 引用符スタイルを適用
			if (quoteStyle === "single") {
				return `'${value.replace(/'/g, "''")}'`;
			}
			if (quoteStyle === "double") {
				return `"${value.replace(/"/g, '\\"')}"`;
			}
			// 特殊文字を含む場合は引用符で囲む
			if (value.includes(":") || value.includes("#") || value.includes("\n")) {
				return `"${value.replace(/"/g, '\\"')}"`;
			}
			return value;
		}
		if (typeof value === "number" || typeof value === "boolean") {
			return String(value);
		}
		if (Array.isArray(value) || typeof value === "object") {
			// 複雑な構造はJSON文字列として扱う（完全なYAML対応は複雑すぎる）
			return JSON.stringify(value);
		}
		return String(value);
	}

	/**
	 * FrontMatterのクローンを作成
	 * @returns 新しいFrontMatterインスタンス
	 */
	clone(): FrontMatter {
		return new FrontMatter({ ...this._data }, this._raw, this.startLine, this.endLine);
	}
}
