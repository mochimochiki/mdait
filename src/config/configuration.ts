import * as vscode from "vscode";

/**
 * 翻訳設定の型定義
 */
export interface TransConfig {
	provider: string;
	model: string;
	markdown: {
		skipCodeBlocks: boolean;
	};
	ollama: {
		endpoint: string;
		model: string;
	};
	// プロバイダ固有設定の拡張用
	[key: string]: unknown;
}

/**
 * 翻訳ペア設定の型定義
 */
export interface TransPair {
	sourceDir: string;
	targetDir: string;
	sourceLang: string;
	targetLang: string;
}

/**
 * 翻訳拡張機能の設定を管理するクラス
 */
export class Configuration {
	/**
	 * 翻訳ペア設定
	 */
	public transPairs: TransPair[] = [];
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
	};
	/**
	 * trans設定
	 */
	public trans: TransConfig = {
		provider: "default",
		model: "gpt-4o",
		markdown: {
			skipCodeBlocks: true,
		},
		ollama: {
			endpoint: "http://localhost:11434",
			model: "llama2",
		},
	};

	/**
	 * 設定を読み込む
	 */
	public async load(): Promise<void> {
		const config = vscode.workspace.getConfiguration("mdait");
		// 翻訳ペア設定の読み込み
		this.transPairs = config.get<TransPair[]>("transPairs") || [];

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
		} // 翻訳設定の読み込み
		const provider = config.get<string>("trans.provider");
		if (provider) {
			this.trans.provider = provider;
		}
		const model = config.get<string>("trans.model");
		if (model) {
			this.trans.model = model;
		}
		const skipCodeBlocks = config.get<boolean>("trans.markdown.skipCodeBlocks");
		if (skipCodeBlocks !== undefined) {
			this.trans.markdown.skipCodeBlocks = skipCodeBlocks;
		}

		// Ollama設定の読み込み
		const ollamaEndpoint = config.get<string>("trans.ollama.endpoint");
		if (ollamaEndpoint) {
			this.trans.ollama.endpoint = ollamaEndpoint;
		}
		const ollamaModel = config.get<string>("trans.ollama.model");
		if (ollamaModel) {
			this.trans.ollama.model = ollamaModel;
		}
	}

	/**
	 * 設定が有効かどうかを検証する
	 * @returns エラーメッセージ。問題がなければnull
	 */
	public validate(): string | null {
		// 翻訳ペアが設定されているか
		if (!this.transPairs || this.transPairs.length === 0) {
			return vscode.l10n.t("Translation pairs (mdait.transPairs) are not configured.");
		}

		// 各翻訳ペアのディレクトリが設定されているか
		for (const pair of this.transPairs) {
			if (!pair.sourceDir) {
				return vscode.l10n.t("Source directory (sourceDir) is not set in translation pair.");
			}
			if (!pair.targetDir) {
				return vscode.l10n.t("Target directory (targetDir) is not set in translation pair.");
			}
		}

		return null;
	}

	/**
	 * 指定されたファイルパスから対応する翻訳ペアを取得
	 * @param targetFilePath ファイルパス
	 * @returns 対応する翻訳ペア（見つからない場合はnull）
	 */
	public getTransPairForTargetFile(targetFilePath: string): TransPair | null {
		const normalizedTargetPath = targetFilePath.replace(/\\/g, "/");

		for (const pair of this.transPairs) {
			const normalizedTargetDir = pair.targetDir.replace(/\\/g, "/");

			if (normalizedTargetPath.includes(normalizedTargetDir)) {
				return pair;
			}
		}

		return null;
	}
}
