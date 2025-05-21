import * as vscode from "vscode";

/**
 * 翻訳拡張機能の設定を管理するクラス
 */
export class Configuration {
	/**
	 * 翻訳ペア設定
	 */
	public transPairs: Array<{ sourceDir: string; targetDir: string }> = [];

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

		// 翻訳ペア設定の読み込み
		this.transPairs =
			config.get<Array<{ sourceDir: string; targetDir: string }>>(
				"transPairs",
			) || [];

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
		// 翻訳ペアが設定されているか
		if (!this.transPairs || this.transPairs.length === 0) {
			return "翻訳ペア(mdait.transPairs)が設定されていません。";
		}

		// 各翻訳ペアのディレクトリが設定されているか
		for (const pair of this.transPairs) {
			if (!pair.sourceDir) {
				return "翻訳ペアに翻訳元ディレクトリ(sourceDir)が設定されていません。";
			}
			if (!pair.targetDir) {
				return "翻訳ペアに翻訳先ディレクトリ(targetDir)が設定されていません。";
			}
		}

		// ファイル拡張子が少なくとも1つ設定されているか
		if (!this.files.extensions || this.files.extensions.length === 0) {
			return "対象ファイルの拡張子が設定されていません。";
		}

		return null;
	}
}
