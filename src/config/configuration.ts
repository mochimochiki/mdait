import * as fs from "node:fs";
import * as path from "node:path";
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
	/** 翻訳時に参照する前後のユニット数（コンテキストウィンドウサイズ） */
	contextSize: number;
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
 * mdait.yamlファイルの型定義
 */
interface MdaitConfig {
	transPairs?: TransPair[];
	ignoredPatterns?: string | string[];
	sync?: {
		autoMarkerLevel?: number;
		autoDelete?: boolean;
	};
	ai?: {
		provider?: string;
		model?: string;
		ollama?: {
			endpoint?: string;
			model?: string;
		};
		debug?: {
			enableStatsLogging?: boolean;
			logPromptAndResponse?: boolean;
		};
	};
	trans?: {
		markdown?: {
			skipCodeBlocks?: boolean;
		};
		contextSize?: number;
	};
	terms?: {
		filename?: string;
		primaryLang?: string;
	};
}

/**
 * 翻訳拡張機能の設定を管理するクラス（シングルトンパターン）
 */
export class Configuration {
	private static instance: Configuration | undefined;
	private configurationWatcher: fs.FSWatcher | undefined;
	private configFilePath: string | undefined;
	private changeCallbacks: Array<() => void> = [];

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
		autoMarkerLevel: 3,
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
		debug: {
			enableStatsLogging: true,
			logPromptAndResponse: false,
		},
	};
	/**
	 * trans設定
	 */
	public trans: TransConfig = {
		markdown: {
			skipCodeBlocks: true,
		},
		contextSize: 1,
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
	private constructor() {}

	/**
	 * Configurationのシングルトンインスタンスを取得する
	 * @returns Configurationインスタンス
	 */
	public static getInstance(): Configuration {
		if (!Configuration.instance) {
			Configuration.instance = new Configuration();
		}
		return Configuration.instance;
	}

	/**
	 * 初期化処理（設定のロードと監視の開始）
	 */
	public async initialize(): Promise<Configuration> {
		await this.load();
		return this;
	}

	/**
	 * シングルトンインスタンスを破棄する（主にテスト用）
	 */
	public static dispose(): void {
		if (Configuration.instance?.configurationWatcher) {
			Configuration.instance.configurationWatcher.close();
		}
		Configuration.instance = undefined;
	}

	/**
	 * 設定ファイルのパスを取得
	 */
	private getConfigFilePath(): string | undefined {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot) {
			return undefined;
		}
		return path.join(workspaceRoot, "mdait.json");
	}

	/**
	 * mdait.jsonが存在し、設定が有効かどうかをチェックする
	 * @returns true: 設定済み、false: 未設定または無効
	 */
	public isConfigured(): boolean {
		const configPath = this.getConfigFilePath();
		if (!configPath) {
			return false;
		}
		if (!fs.existsSync(configPath)) {
			return false;
		}
		// transPairsが有効に設定されているか
		return this.transPairs.length > 0;
	}

	/**
	 * 設定変更の監視を設定する
	 */
	private setupConfigurationWatcher(): void {
		if (!this.configFilePath) {
			return;
		}

		// 設定ファイルの変更を監視
		try {
			this.configurationWatcher = fs.watch(this.configFilePath, (eventType) => {
				if (eventType === "change") {
					this.load().catch((error) => {
						console.error("Failed to reload configuration:", error);
					});
				}
			});
		} catch (error) {
			console.error("Failed to setup configuration watcher:", error);
		}
	}

	/**
	 * 設定変更時のコールバックを登録
	 */
	public onConfigurationChanged(callback: () => void): void {
		this.changeCallbacks.push(callback);
	}

	/**
	 * 設定変更を通知
	 */
	private notifyConfigurationChanged(): void {
		for (const callback of this.changeCallbacks) {
			try {
				callback();
			} catch (error) {
				console.error("Error in configuration change callback:", error);
			}
		}
	}

	/**
	 * 設定を読み込む
	 */
	private async load(): Promise<void> {
		// 設定ファイルのパスを取得
		this.configFilePath = this.getConfigFilePath();
		if (!this.configFilePath) {
			throw new Error("Workspace folder not found");
		}

		// 設定ファイルが存在しない場合はエラー
		if (!fs.existsSync(this.configFilePath)) {
			throw new Error(`Configuration file not found: ${this.configFilePath}`);
		}

		try {
			// JSONファイルを読み込む
			const fileContent = fs.readFileSync(this.configFilePath, "utf8");
			const config = JSON.parse(fileContent) as MdaitConfig;

			if (!config || typeof config !== "object") {
				throw new Error("Invalid configuration file format");
			}

			// 翻訳ペア設定の読み込み
			if (config.transPairs) {
				this.transPairs = config.transPairs;
			}

			// 除外パターンの読み込み
			if (config.ignoredPatterns) {
				if (Array.isArray(config.ignoredPatterns)) {
					this.ignoredPatterns = config.ignoredPatterns.join(",");
				} else {
					this.ignoredPatterns = config.ignoredPatterns;
				}
			}

			// sync設定の読み込み
			if (config.sync) {
				if (config.sync.autoMarkerLevel !== undefined) {
					this.sync.autoMarkerLevel = config.sync.autoMarkerLevel;
				}
				if (config.sync.autoDelete !== undefined) {
					this.sync.autoDelete = config.sync.autoDelete;
				}
			}

			// AI設定の読み込み
			if (config.ai) {
				if (config.ai.provider) {
					this.ai.provider = config.ai.provider;
				}
				if (config.ai.model) {
					this.ai.model = config.ai.model;
				}
				if (config.ai.ollama) {
					if (config.ai.ollama.endpoint) {
						this.ai.ollama.endpoint = config.ai.ollama.endpoint;
					}
					if (config.ai.ollama.model) {
						this.ai.ollama.model = config.ai.ollama.model;
					}
				}
				if (config.ai.debug) {
					if (!this.ai.debug) {
						this.ai.debug = {
							enableStatsLogging: true,
							logPromptAndResponse: false,
						};
					}
					if (config.ai.debug.enableStatsLogging !== undefined) {
						this.ai.debug.enableStatsLogging = config.ai.debug.enableStatsLogging;
					}
					if (config.ai.debug.logPromptAndResponse !== undefined) {
						this.ai.debug.logPromptAndResponse = config.ai.debug.logPromptAndResponse;
					}
				}
			}

			// 翻訳設定の読み込み
			if (config.trans?.markdown) {
				if (config.trans.markdown.skipCodeBlocks !== undefined) {
					this.trans.markdown.skipCodeBlocks = config.trans.markdown.skipCodeBlocks;
				}
			}
			if (config.trans?.contextSize !== undefined) {
				this.trans.contextSize = config.trans.contextSize;
			}

			// 用語集設定の読み込み
			if (config.terms) {
				if (config.terms.filename) {
					this.terms.filename = config.terms.filename;
				}
				if (config.terms.primaryLang) {
					this.terms.primaryLang = config.terms.primaryLang;
				}
			}

			// 設定ファイルの監視を開始（初回のみ）
			if (!this.configurationWatcher) {
				this.setupConfigurationWatcher();
			}

			// 設定変更を通知
			this.notifyConfigurationChanged();
		} catch (error) {
			throw new Error(`Failed to load configuration: ${error}`);
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
