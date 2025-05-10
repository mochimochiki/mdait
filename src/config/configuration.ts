import * as vscode from "vscode";

/**
 * 翻訳拡張機能の設定を管理するクラス
 */
export class Configuration {
	/**
	 * ディレクトリ設定
	 */
	public directories = {
		source: "",
		target: "",
	};

	/**
	 * ファイル設定
	 */
	public files = {
		extensions: [".md", ".csv"],
		includePattern: "**/*",
		excludePattern: "**/node_modules/**",
	};

	/**
	 * 翻訳設定
	 */
	public translation = {
		provider: "default",
		markdown: {
			skipCodeBlocks: true,
		},
		csv: {
			delimiter: ",",
		},
	};

	/**
	 * 設定を読み込む
	 */ public async load(): Promise<void> {
		const config = vscode.workspace.getConfiguration("mdait");

		// ディレクトリ設定の読み込み
		this.directories.source = config.get<string>("directories.source") || "";
		this.directories.target = config.get<string>("directories.target") || "";

		// ファイル設定の読み込み
		const extensions = config.get<string[]>("files.extensions");
		if (extensions) {
			this.files.extensions = extensions;
		}

		const includePattern = config.get<string>("files.includePattern");
		if (includePattern) {
			this.files.includePattern = includePattern;
		}

		const excludePattern = config.get<string>("files.excludePattern");
		if (excludePattern) {
			this.files.excludePattern = excludePattern;
		}

		// 翻訳設定の読み込み
		const provider = config.get<string>("translation.provider");
		if (provider) {
			this.translation.provider = provider;
		}

		const skipCodeBlocks = config.get<boolean>(
			"translation.markdown.skipCodeBlocks",
		);
		if (skipCodeBlocks !== undefined) {
			this.translation.markdown.skipCodeBlocks = skipCodeBlocks;
		}

		const delimiter = config.get<string>("translation.csv.delimiter");
		if (delimiter) {
			this.translation.csv.delimiter = delimiter;
		}
	}

	/**
	 * 設定が有効かどうかを検証する
	 * @returns エラーメッセージ。問題がなければnull
	 */
	public validate(): string | null {
		// ソースディレクトリが設定されているか
		if (!this.directories.source) {
			return "翻訳元ディレクトリが設定されていません。";
		}

		// ターゲットディレクトリが設定されているか
		if (!this.directories.target) {
			return "翻訳先ディレクトリが設定されていません。";
		}

		// ファイル拡張子が少なくとも1つ設定されているか
		if (!this.files.extensions || this.files.extensions.length === 0) {
			return "対象ファイルの拡張子が設定されていません。";
		}

		return null;
	}
}
