import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { isLiteralApiKey } from "../../core/diagnostics/setup-doctor";
import {
	type MarkerProvider,
	embeddedMarkerProvider,
	externalMarkerProvider,
} from "../../core/markdown/marker-provider";
import { Logger, formatError } from "../logging/logger";

/**
 * AI設定の型定義
 */
export interface AIConfig {
	provider: string;
	/** VS Code Language Model API の vendor 識別子（既定: "copilot"） */
	vendor?: string;
	model: string;
	ollama: {
		endpoint: string;
		model: string;
		/** リクエスト/ストリーミングチャンク間のタイムアウト（秒） */
		timeoutSec?: number;
		/**
		 * モデルをメモリに保持する時間（例: "10m"、秒数指定も可）。
		 * 未指定時はリクエストに含めず、Ollamaサーバーの既定値（5分）に従う
		 */
		keepAlive?: string | number;
	};
	openai?: {
		apiKey?: string;
		baseURL?: string;
		maxTokens?: number;
		timeoutSec?: number;
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
	frontmatter: {
		keys: string[];
	};
	/** 翻訳時に参照する前後のユニット数（コンテキストウィンドウサイズ） */
	contextSize: number;
	/** 翻訳失敗時のリトライ上限 */
	retryLimit: number;
	/** 非MDファイルの最大サイズ（バイト）。超過時はスキップ */
	maxFileSize: number;
	/**
	 * 1回の処理で扱うユニット数の上限（全般コストガード）。
	 * trans・aiSync.review・aiSync.align が共通で参照する。
	 * `0` で上限なし。
	 */
	maxUnitsPerRun: number;
	/** ディレクトリ翻訳のファイル単位同時実行数（1〜8。1で逐次実行） */
	concurrency: number;
	/** 追加の翻訳対象拡張子（.mdは常に含まれる） */
	extensions?: string[];
	// 翻訳固有設定の拡張用
	[key: string]: unknown;
}

/**
 * TM設定の型定義
 */
export interface TmConfig {
	enabled: boolean;
	maxReferences: number;
	/** tm-commit focused retry の上限 */
	retryLimit: number;
	/** TM検索時の最低クエリ文字数（normalize後の行がこの文字数未満の場合除外） */
	minQueryLength: number;
	[key: string]: unknown;
}

/**
 * アセットコピー設定の型。
 * - `true`: 翻訳対象拡張子以外を全てコピー
 * - `false`: コピーしない
 * - `string[]`: 拡張子ホワイトリスト（例: `[".png", ".jpg"]`）。空配列は `false` と等価
 */
export type CopyAssetsConfig = boolean | string[];

/**
 * 翻訳ペア設定の型定義
 */
export interface TransPair {
	sourceDir: string;
	targetDir: string;
	sourceLang: string;
	targetLang: string;
	/** アセットコピー設定（省略時はグローバル設定 sync.copyAssets を継承） */
	copyAssets?: CopyAssetsConfig;
}

/**
 * 孤立ターゲット（ソース側に対応ユニットがない訳文側ユニット）の処理ポリシー
 * - delete: 自動削除（旧 autoDelete: true 相当）
 * - verify: need:verify-deletion を付与して手動確認に委ねる（旧 autoDelete: false 相当）
 * - keep: need:keep を付与して恒久保持（独自ユニット。sync/trans が触れない）
 * - backfill: 原文側にプレースホルダを生成し need:backfill を付与（transが逆方向翻訳で埋め戻す）
 */
export type OrphanTargetPolicy = "delete" | "verify" | "keep" | "backfill";

/**
 * mdait.yamlファイルの型定義
 */
interface MdaitConfig {
	transPairs?: TransPair[];
	primaryLang?: string;
	ignoredPatterns?: string | string[];
	sync?: {
		level?: number;
		autoDelete?: boolean;
		autoSyncOnSave?: boolean;
		copyAssets?: CopyAssetsConfig;
		orphanTargetPolicy?: OrphanTargetPolicy;
	};
	markers?: {
		mode?: "embedded" | "external";
	};
	ai?: {
		provider?: string;
		vendor?: string;
		model?: string;
		ollama?: {
			endpoint?: string;
			model?: string;
			timeoutSec?: number;
			keepAlive?: string | number;
		};
		openai?: {
			apiKey?: string;
			baseURL?: string;
			maxTokens?: number;
			timeoutSec?: number;
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
		frontmatter?: {
			keys?: string[];
		};
		contextSize?: number;
		retryLimit?: number;
		maxFileSize?: number;
		concurrency?: number;
		extensions?: string[];
		maxUnitsPerRun?: number;
	};
	terms?: {
		filename?: string;
	};
	tm?: {
		enabled?: boolean;
		maxReferences?: number;
		retryLimit?: number;
		minQueryLength?: number;
	};
	prompts?: {
		"trans.translate"?: string;
		"trans.revisePatch"?: string;
		"term.detect"?: string;
		"term.extractFromTranslations"?: string;
		"term.translateTerms"?: string;
	};
	aiSync?: {
		review?: {
			autoApprove?: boolean;
			batchSize?: number;
		};
	};
}

/**
 * AIペアリング検証（aiSync.review）設定の型定義
 */
export interface AiSyncReviewConfig {
	/** 高確信 match の need:review を自動解除するか（false でレポートのみのセーフモード） */
	autoApprove: boolean;
	/** 1回のLLM呼び出しで検証するペア数（1で従来の単ペアプロンプト） */
	batchSize: number;
}

/**
 * 翻訳拡張機能の設定を管理するクラス（シングルトンパターン）
 */
export class Configuration {
	private static instance: Configuration | undefined;
	private configurationWatcher: fs.FSWatcher | undefined;
	private configFilePath: string | undefined;
	private customConfigPath: string | undefined;
	private changeCallbacks: Array<() => void> = [];
	/** 直書きAPIキー警告の重複抑制（直近に警告した生値を記録） */
	private lastLeakWarnedKey: string | undefined;

	/**
	 * 翻訳ペア設定
	 */
	public transPairs: TransPair[] = [];
	/**
	 * 除外パターン
	 */
	public ignoredPatterns = "**/node_modules/**";
	/**
	 * 基準言語
	 */
	public primaryLang = "";
	/**
	 * sync設定
	 */
	public sync: {
		level: number;
		autoDelete: boolean;
		autoSyncOnSave: boolean;
		copyAssets: CopyAssetsConfig;
		/** 未指定時は autoDelete から解決する（getOrphanTargetPolicy() を使用すること） */
		orphanTargetPolicy?: OrphanTargetPolicy;
	} = {
		level: 3,
		autoDelete: true,
		autoSyncOnSave: true,
		copyAssets: true,
	};

	/**
	 * 孤立ターゲットポリシーを解決して返す。
	 * orphanTargetPolicy が明示されていればそれを優先し、
	 * 未指定なら autoDelete から後方互換マッピングする（true→delete、false→verify）。
	 */
	public getOrphanTargetPolicy(): OrphanTargetPolicy {
		if (this.sync.orphanTargetPolicy) {
			return this.sync.orphanTargetPolicy;
		}
		return this.sync.autoDelete ? "delete" : "verify";
	}
	/**
	 * マーカー保管方式設定
	 * - embedded（既定）: マーカーを本文に埋め込む
	 * - external: マーカーを `.mdait/unit-state` に退避する
	 */
	public markers: {
		mode: "embedded" | "external";
	} = {
		mode: "embedded",
	};
	/**
	 * AI設定
	 */
	public ai: AIConfig = {
		provider: "default",
		vendor: "copilot",
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
		frontmatter: {
			keys: ["title", "description"],
		},
		contextSize: 1,
		retryLimit: 1,
		maxFileSize: 51200,
		concurrency: 3,
		maxUnitsPerRun: 300,
	};
	/**
	 * 用語集設定
	 */
	public terms = {
		filename: "terms.csv", // デフォルトはCSV形式
	};
	/**
	 * プロンプト設定（カスタムプロンプトファイルパス）
	 */
	public prompts: Record<string, string> = {};
	/**
	 * 翻訳メモリ（TM）設定
	 */
	public tm: TmConfig = {
		enabled: true,
		maxReferences: 5,
		retryLimit: 1,
		minQueryLength: 10,
	};
	/**
	 * AIペアリング検証（aiSync.review）設定
	 */
	public aiSync: {
		review: AiSyncReviewConfig;
	} = {
		review: {
			autoApprove: true,
			batchSize: 3,
		},
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
	 * @param customPath カスタム設定ファイルパス。指定がない場合はワークスペースルートの .mdait/mdait.json を使用
	 */
	public async initialize(customPath?: string): Promise<Configuration> {
		const previousCustomConfigPath = this.customConfigPath;
		if (customPath !== undefined && customPath !== this.customConfigPath) {
			if (this.configurationWatcher) {
				this.configurationWatcher.close();
				this.configurationWatcher = undefined;
			}
			this.customConfigPath = customPath;
		}
		try {
			await this.load();
		} catch (error) {
			this.customConfigPath = previousCustomConfigPath;
			throw error;
		}
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
	 * 設定ファイルのパスを取得。
	 * カスタムパスが設定されている場合はそれを返し、なければワークスペースルートの .mdait/mdait.json を返す
	 */
	public getConfigFilePath(): string | undefined {
		if (this.customConfigPath) {
			return this.customConfigPath;
		}
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot) {
			return undefined;
		}
		return path.join(workspaceRoot, ".mdait", "mdait.json");
	}

	/**
	 * 設定ファイルのベースディレクトリを取得。
	 * .mdait の親ディレクトリ（ユーザーが管理するフォルダ）を返す。
	 * transPairs の sourceDir/targetDir のパス解決基準として使用する。
	 * カスタムパスなしの場合はワークスペースルートと同一になるため後方互換あり。
	 */
	public getConfigBaseDir(): string {
		const configFilePath = this.getConfigFilePath();
		if (configFilePath) {
			return path.dirname(path.dirname(configFilePath));
		}
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		return workspaceRoot ?? "";
	}

	/**
	 * .mdaitディレクトリの絶対パスを取得する。
	 * カスタムコンフィグパス使用時はそのディレクトリ配下の .mdait を返す。
	 */
	public getMdaitDir(): string {
		return path.join(this.getConfigBaseDir(), ".mdait");
	}

	/**
	 * unit-state ファイル（翻訳ユニットの状態管理TSV）の絶対パスを取得する。
	 */
	public getUnitStateFilePath(): string {
		return path.join(this.getMdaitDir(), "unit-state");
	}

	/**
	 * マーカー保管方式が external かどうかを返す。
	 */
	public isExternalMarkers(): boolean {
		return this.markers.mode === "external";
	}

	/**
	 * 現在のマーカー保管方式に対応する MarkerProvider を返す。
	 * external なら外部ストア Provider、それ以外は埋め込み Provider（既定）。
	 */
	public getMarkerProvider(): MarkerProvider {
		return this.isExternalMarkers() ? externalMarkerProvider : embeddedMarkerProvider;
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
		return this.validate() === null;
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
						// 古い設定のまま動き続けるため、ユーザーにも通知する
						Logger.getInstance().error(
							"config",
							"Failed to reload configuration",
							formatError(error),
						);
						vscode.window.showErrorMessage(
							vscode.l10n.t(
								"Failed to reload mdait.json: {0}",
								(error as Error).message,
							),
						);
					});
				}
			});
		} catch (error) {
			Logger.getInstance().error(
				"config",
				"Failed to setup configuration watcher",
				formatError(error),
			);
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
				Logger.getInstance().error(
					"config",
					"Error in configuration change callback",
					formatError(error),
				);
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

			// 基準言語の読み込み
			if (config.primaryLang) {
				this.primaryLang = config.primaryLang;
			}

			// sync設定の読み込み
			if (config.sync) {
				if (config.sync.level !== undefined) {
					this.sync.level = config.sync.level;
				}
				if (config.sync.autoDelete !== undefined) {
					this.sync.autoDelete = config.sync.autoDelete;
				}
				if (config.sync.autoSyncOnSave !== undefined) {
					this.sync.autoSyncOnSave = config.sync.autoSyncOnSave;
				}
				if (config.sync.copyAssets !== undefined) {
					this.sync.copyAssets = config.sync.copyAssets;
				}
				if (
					config.sync.orphanTargetPolicy === "delete" ||
					config.sync.orphanTargetPolicy === "verify" ||
					config.sync.orphanTargetPolicy === "keep" ||
					config.sync.orphanTargetPolicy === "backfill"
				) {
					this.sync.orphanTargetPolicy = config.sync.orphanTargetPolicy;
				}
			}

			// markers設定の読み込み
			if (config.markers?.mode === "embedded" || config.markers?.mode === "external") {
				this.markers.mode = config.markers.mode;
			}

			// AI設定の読み込み
			if (config.ai) {
				if (config.ai.provider) {
					this.ai.provider = config.ai.provider;
				}
				if (config.ai.vendor) {
					this.ai.vendor = config.ai.vendor;
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
					if (config.ai.ollama.timeoutSec !== undefined) {
						this.ai.ollama.timeoutSec = Math.max(1, config.ai.ollama.timeoutSec);
					}
					if (config.ai.ollama.keepAlive !== undefined) {
						this.ai.ollama.keepAlive = config.ai.ollama.keepAlive;
					}
				}
				if (config.ai.openai) {
					if (!this.ai.openai) {
						this.ai.openai = {};
					}
					if (config.ai.openai.apiKey) {
						// 展開前の生値で直書き（漏洩）を検知し警告する: P5
						this.warnIfApiKeyLiteral(
							config.ai.provider,
							config.ai.openai.apiKey,
						);
						this.ai.openai.apiKey = this.expandEnvironmentVariables(
							config.ai.openai.apiKey,
						);
					}
					if (config.ai.openai.baseURL) {
						this.ai.openai.baseURL = config.ai.openai.baseURL;
					}
					if (config.ai.openai.maxTokens !== undefined) {
						this.ai.openai.maxTokens = config.ai.openai.maxTokens;
					}
					if (config.ai.openai.timeoutSec !== undefined) {
						this.ai.openai.timeoutSec = config.ai.openai.timeoutSec;
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
						this.ai.debug.enableStatsLogging =
							config.ai.debug.enableStatsLogging;
					}
					if (config.ai.debug.logPromptAndResponse !== undefined) {
						this.ai.debug.logPromptAndResponse =
							config.ai.debug.logPromptAndResponse;
					}
				}
			}

			// 翻訳設定の読み込み
			if (config.trans?.markdown) {
				if (config.trans.markdown.skipCodeBlocks !== undefined) {
					this.trans.markdown.skipCodeBlocks =
						config.trans.markdown.skipCodeBlocks;
				}
			}
			if (config.trans?.frontmatter?.keys !== undefined) {
				if (Array.isArray(config.trans.frontmatter.keys)) {
					this.trans.frontmatter.keys = config.trans.frontmatter.keys.filter(
						(key): key is string =>
							typeof key === "string" && key.trim().length > 0,
					);
				}
			}
			if (config.trans?.contextSize !== undefined) {
				this.trans.contextSize = config.trans.contextSize;
			}
			if (config.trans?.retryLimit !== undefined) {
				const normalizedRetryLimit = Math.min(
					5,
					Math.max(1, config.trans.retryLimit),
				);
				this.trans.retryLimit = normalizedRetryLimit;
			}
			if (config.trans?.maxFileSize !== undefined) {
				this.trans.maxFileSize = Math.max(1024, config.trans.maxFileSize);
			}
			if (config.trans?.concurrency !== undefined) {
				// ファイル単位並列翻訳の同時実行数（1〜8にクランプ。1で逐次実行）
				this.trans.concurrency = Math.min(8, Math.max(1, Math.floor(config.trans.concurrency)));
			}
			if (config.trans?.extensions !== undefined) {
				if (Array.isArray(config.trans.extensions)) {
					this.trans.extensions = config.trans.extensions;
				}
			}
			if (Number.isFinite(config.trans?.maxUnitsPerRun)) {
				// 1回の処理で扱うユニット数の上限（全般コストガード）。
				// 0 以下は「上限なし」として 0 に正規化、正値は整数へ丸める。
				const raw = Math.floor(config.trans?.maxUnitsPerRun as number);
				this.trans.maxUnitsPerRun = raw <= 0 ? 0 : raw;
			}

			// 用語集設定の読み込み
			if (config.terms) {
				if (config.terms.filename) {
					this.terms.filename = config.terms.filename;
				}
			}

			// プロンプト設定の読み込み
			if (config.prompts) {
				this.prompts = {};
				for (const [key, value] of Object.entries(config.prompts)) {
					if (typeof value === "string") {
						this.prompts[key] = value;
					}
				}
			}

			// TM設定の読み込み
			if (config.tm) {
				if (config.tm.enabled !== undefined) {
					this.tm.enabled = config.tm.enabled;
				}
				if (config.tm.maxReferences !== undefined) {
					this.tm.maxReferences = Math.max(
						1,
						Math.min(20, config.tm.maxReferences),
					);
				}
				if (config.tm.retryLimit !== undefined) {
					this.tm.retryLimit = Math.min(5, Math.max(1, config.tm.retryLimit));
				}
				if (config.tm.minQueryLength !== undefined) {
					this.tm.minQueryLength = Math.max(
						1,
						Math.min(100, config.tm.minQueryLength),
					);
				}
			}

			// aiSync設定の読み込み
			// autoApprove は need:review 自動解除のゲートのため、型不正（文字列等）を
			// truthy として拾わないよう厳密に型チェックする。
			// （confidence 閾値・align 詳細はコード内定数で最適値固定・設定廃止）
			if (config.aiSync?.review) {
				if (typeof config.aiSync.review.autoApprove === "boolean") {
					this.aiSync.review.autoApprove = config.aiSync.review.autoApprove;
				}
				if (Number.isFinite(config.aiSync.review.batchSize)) {
					this.aiSync.review.batchSize = Math.min(
						10,
						Math.max(1, Math.floor(config.aiSync.review.batchSize as number)),
					);
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
	 * openai プロバイダで apiKey が直書き（${env:} 参照でない）なら漏洩警告を表示する。
	 * 同じ生値に対する連続再ロードでは重複警告しない。
	 */
	private warnIfApiKeyLiteral(
		provider: string | undefined,
		rawApiKey: string,
	): void {
		if (provider !== "openai" || !isLiteralApiKey(rawApiKey)) {
			return;
		}
		if (this.lastLeakWarnedKey === rawApiKey) {
			return;
		}
		this.lastLeakWarnedKey = rawApiKey;
		const useEnv = vscode.l10n.t("How to use ${env:}");
		vscode.window
			.showWarningMessage(
				vscode.l10n.t(
					"OpenAI apiKey is written directly in mdait.json. Since this file is tracked by git, the key may leak. Use the ${env:OPENAI_API_KEY} syntax instead.",
				),
				useEnv,
			)
			.then((choice) => {
				if (choice === useEnv) {
					vscode.env.openExternal(
						vscode.Uri.parse(
							"https://github.com/mochimochiki/mdait/blob/main/docs/guide/ja/troubleshooting.md",
						),
					);
				}
			});
	}

	/**
	 * 設定が有効かどうかを検証する
	 * @returns エラーメッセージ。問題がなければnull
	 */
	public validate(): string | null {
		// 翻訳ペアが設定されているか
		if (!this.transPairs || this.transPairs.length === 0) {
			return vscode.l10n.t(
				"Translation pairs (mdait.transPairs) are not configured.",
			);
		}

		// 各翻訳ペアのディレクトリが設定されているか
		for (const pair of this.transPairs) {
			if (!pair.sourceDir) {
				return vscode.l10n.t(
					"Source directory (sourceDir) is not set in translation pair.",
				);
			}
			if (!pair.targetDir) {
				return vscode.l10n.t(
					"Target directory (targetDir) is not set in translation pair.",
				);
			}
		}

		if (!this.primaryLang) {
			return vscode.l10n.t("Primary language (primaryLang) is not configured.");
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
		const configFilePath = this.getConfigFilePath();
		if (!configFilePath) {
			throw new Error("Configuration file not found");
		}
		return path.join(path.dirname(configFilePath), this.terms.filename);
	}

	/**
	 * TMファイルのパスを取得
	 * @returns TMファイルの絶対パス
	 */
	public getTmFilePath(): string {
		const configFilePath = this.getConfigFilePath();
		if (!configFilePath) {
			throw new Error("Configuration file not found");
		}
		return path.join(path.dirname(configFilePath), "translations.tmx");
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
	 * TM機能が有効かどうかを取得
	 * @returns TM機能の有効/無効
	 */
	public getTmEnabled(): boolean {
		return this.tm.enabled;
	}

	/**
	 * TM参照の最大数を取得
	 * @returns 最大参照数
	 */
	public getTmMaxReferences(): number {
		return this.tm.maxReferences;
	}

	/**
	 * tm-commit focused retry の上限を取得
	 * @returns 最大リトライ回数
	 */
	public getTmRetryLimit(): number {
		return this.tm.retryLimit;
	}

	/**
	 * TM検索時の最低クエリ文字数を取得
	 * @returns 最低クエリ文字数
	 */
	public getTmMinQueryLength(): number {
		return this.tm.minQueryLength;
	}

	/**
	 * 環境変数を展開する
	 * ${env:VARIABLE_NAME} 形式の文字列を環境変数の値に置き換えます
	 * @param value 展開する文字列
	 * @returns 展開後の文字列
	 */
	private expandEnvironmentVariables(value: string): string {
		return value.replace(/\$\{env:([^}]+)\}/g, (_, envVarName) => {
			return process.env[envVarName] || "";
		});
	}

	/**
	 * 基準言語を取得
	 * @returns 基準言語コード
	 */
	public getTermsPrimaryLang(): string {
		return this.primaryLang;
	}
}
