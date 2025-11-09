import * as vscode from "vscode";

/**
 * AI設定の型定義
 */
export interface AIConfig {
	provider: string;
	model: string;
	ollama: {
		endpoint: string;
		model: string;
	};
	debug?: {
		enableStatsLogging: boolean;
		logPromptAndResponse: boolean;
	};
	// プロバイダ固有設定の拡張用
	[key: string]: unknown;
}

/**
 * 翻訳設定の型定義
 */
export interface TransConfig {
	markdown: {
		skipCodeBlocks: boolean;
	};
	// 翻訳固有設定の拡張用
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
 * 翻訳拡張機能の設定を管理するクラス（シングルトンパターン）
 */
export class Configuration {
	private static instance: Configuration | undefined;
	private configurationChangeListener: vscode.Disposable | undefined;

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
	 * AI設定
	 */
	public ai: AIConfig = {
		provider: "default",
		model: "gpt-4o",
		ollama: {
			endpoint: "http://localhost:11434",
			model: "llama2",
		},
	};
	/**
	 * trans設定
	 */
	public trans: TransConfig = {
		markdown: {
			skipCodeBlocks: true,
		},
	};
	/**
	 * 用語集設定
	 */
	public terms = {
		filename: "terms.csv", // デフォルトはCSV形式
		primaryLang: "", // 用語管理の基準言語
	};

	/**
	 * プライベートコンストラクタ（シングルトンパターン）
	 */
	private constructor() {
		this.setupConfigurationWatcher();
	}

	/**
	 * Configurationのシングルトンインスタンスを取得する
	 * @returns Configurationインスタンス
	 */
	public static getInstance(): Configuration {
		if (!Configuration.instance) {
			Configuration.instance = new Configuration();
			Configuration.instance.initialize();
		}
		return Configuration.instance;
	}

	/**
	 * 初期化処理（設定のロードと監視の開始）
	 */
	public async initialize(): Promise<Configuration> {
		const instance = Configuration.getInstance();
		await instance.load();
		return instance;
	}

	/**
	 * シングルトンインスタンスを破棄する（主にテスト用）
	 */
	public static dispose(): void {
		if (Configuration.instance?.configurationChangeListener) {
			Configuration.instance.configurationChangeListener.dispose();
		}
		Configuration.instance = undefined;
	}

	/**
	 * 設定変更の監視を設定する
	 */
	private setupConfigurationWatcher(): void {
		this.configurationChangeListener = vscode.workspace.onDidChangeConfiguration((event) => {
			// mdait関連の設定が変更された場合のみリロード
			if (event.affectsConfiguration("mdait")) {
				this.load().catch((error) => {
					console.error("Failed to reload configuration:", error);
				});
			}
		});
	}

	/**
	 * 設定を読み込む
	 */
	private async load(): Promise<void> {
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
		}

		// AI設定の読み込み
		const aiProvider = config.get<string>("ai.provider");
		if (aiProvider) {
			this.ai.provider = aiProvider;
		}
		const aiModel = config.get<string>("ai.model");
		if (aiModel) {
			this.ai.model = aiModel;
		}

		// Ollama設定の読み込み
		const ollamaEndpoint = config.get<string>("ai.ollama.endpoint");
		if (ollamaEndpoint) {
			this.ai.ollama.endpoint = ollamaEndpoint;
		}
		const ollamaModel = config.get<string>("ai.ollama.model");
		if (ollamaModel) {
			this.ai.ollama.model = ollamaModel;
		}

		// AIデバッグ設定の読み込み
		const enableStatsLogging = config.get<boolean>("ai.debug.enableStatsLogging");
		const logPromptAndResponse = config.get<boolean>("ai.debug.logPromptAndResponse");
		if (enableStatsLogging !== undefined || logPromptAndResponse !== undefined) {
			if (!this.ai.debug) {
				this.ai.debug = {
					enableStatsLogging: enableStatsLogging ?? false,
					logPromptAndResponse: logPromptAndResponse ?? false,
				};
			} else {
				if (enableStatsLogging !== undefined) {
					this.ai.debug.enableStatsLogging = enableStatsLogging;
				}
				if (logPromptAndResponse !== undefined) {
					this.ai.debug.logPromptAndResponse = logPromptAndResponse;
				}
			}
		}

		// 翻訳設定の読み込み
		const skipCodeBlocks = config.get<boolean>("trans.markdown.skipCodeBlocks");
		if (skipCodeBlocks !== undefined) {
			this.trans.markdown.skipCodeBlocks = skipCodeBlocks;
		}

		// 用語集設定の読み込み
		const termsFilename = config.get<string>("terms.filename");
		if (termsFilename) {
			this.terms.filename = termsFilename;
		}
		const termsprimaryLang = config.get<string>("terms.primaryLang");
		if (termsprimaryLang) {
			this.terms.primaryLang = termsprimaryLang;
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

	/**
	 * 指定されたファイルパスから対応する翻訳ペア（sourceDir側）を取得
	 * @param sourceFilePath ファイルパス
	 * @returns 対応する翻訳ペア（見つからない場合はnull）
	 */
	public getTransPairForSourceFile(sourceFilePath: string): TransPair | null {
		const normalizedSourcePath = sourceFilePath.replace(/\\/g, "/");

		for (const pair of this.transPairs) {
			const normalizedSourceDir = pair.sourceDir.replace(/\\/g, "/");

			if (normalizedSourcePath.includes(normalizedSourceDir)) {
				return pair;
			}
		}

		return null;
	}

	/**
	 * 用語集ファイルのパスを取得
	 * @returns 用語集ファイルの絶対パス
	 */
	public getTermsFilePath(): string {
		// ワークスペースルートを取得
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot) {
			throw new Error("Workspace not found");
		}

		const path = require("node:path");
		return path.join(workspaceRoot, ".mdait", this.terms.filename);
	}

	/**
	 * 用語集ファイル名から形式を判定
	 * @returns 'csv' | 'yaml'
	 */
	public getTermsFileFormat(): "csv" | "yaml" {
		const ext = this.terms.filename.toLowerCase().split(".").pop();
		return ext === "yaml" || ext === "yml" ? "yaml" : "csv";
	}

	/**
	 * 用語集の基準言語を取得
	 * @returns 基準言語コード
	 */
	public getTermsPrimaryLang(): string {
		return this.terms.primaryLang;
	}
}
