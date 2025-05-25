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
	 * 除外パターン
	 */
	public ignoredPatterns = "**/node_modules/**";
	/**
	 * sync設定
	 */
	public sync = {
		autoMarkerLevel: 2,
		autoDelete: true,
	}; /**
	 * 翻訳設定
	 */
	public trans = {
		provider: "default",
		markdown: {
			skipCodeBlocks: true,
		},
	};

	/**
	 * 設定を読み込む
	 */
	public async load(): Promise<void> {
		const config = vscode.workspace.getConfiguration("mdait");

		// 翻訳ペア設定の読み込み
		this.transPairs =
			config.get<Array<{ sourceDir: string; targetDir: string }>>(
				"transPairs",
			) || [];

		// 除外パターンの読み込み
		const ignoredPatterns = config.get<string>("ignoredPatterns");
		if (ignoredPatterns) {
			this.ignoredPatterns = ignoredPatterns;
		}

		// sync設定の読み込み
		const autoMarkerLevel = config.get<number>("sync.autoMarkerLevel");
		if (autoMarkerLevel !== undefined) {
			this.sync.autoMarkerLevel = autoMarkerLevel;
		}

		const autoDelete = config.get<boolean>("sync.autoDelete");
		if (autoDelete !== undefined) {
			this.sync.autoDelete = autoDelete;
		}
		// 翻訳設定の読み込み
		const provider = config.get<string>("trans.provider");
		if (provider) {
			this.trans.provider = provider;
		}
		const skipCodeBlocks = config.get<boolean>("trans.markdown.skipCodeBlocks");
		if (skipCodeBlocks !== undefined) {
			this.trans.markdown.skipCodeBlocks = skipCodeBlocks;
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

		return null;
	}
}
