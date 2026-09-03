/**
 * @file prompt-provider.ts
 * @description プロンプト提供サービス
 * デフォルトプロンプトと外部ファイルからのカスタムプロンプトを管理
 */

import * as fs from "node:fs";
import * as path from "node:path";
import matter from "gray-matter";
import * as vscode from "vscode";
import { Configuration } from "../infra/config/configuration";
import { DEFAULT_PROMPTS, type PromptId, SOURCE_TEXT_SEPARATOR, USER_SECTION_MARKER } from "./defaults";

/**
 * プロンプト内の変数を表す型
 */
export type PromptVariables = Record<string, string | undefined>;

/**
 * system / user-section に分割されたプロンプト
 * system はユニット間で固定となり、プロバイダーのプレフィックスキャッシュが効く
 */
export interface PromptParts {
	/** 静的なシステムプロンプト（デフォルトの翻訳系テンプレートでは変数を含まず、プロンプト種別ごとに固定） */
	system: string;
	/** ユニットごとの可変コンテキスト（変数置換済み。user message の先頭に配置する） */
	userContext: string;
	/** user-section マーカーを持たないレガシーテンプレートかどうか */
	isLegacy: boolean;
}

/**
 * PromptParts と翻訳対象本文から user message を構築する
 * レガシーテンプレートの場合は本文のみを返す（従来挙動を維持）
 *
 * @param parts 分割済みプロンプト
 * @param sourceText 翻訳対象の本文
 * @returns user message 文字列
 */
export function buildUserMessage(parts: PromptParts, sourceText: string): string {
	if (parts.isLegacy) {
		return sourceText;
	}
	const context = parts.userContext ? `${parts.userContext}\n\n` : "";
	return `${context}${SOURCE_TEXT_SEPARATOR}\n${sourceText}`;
}

/**
 * インストラクションファイルのフロントマター
 */
interface InstructionFrontMatter {
	/** 適用するプロンプトIDのリスト（省略時は全プロンプトに適用） */
	prompts?: string[];
}

/**
 * インストラクション情報
 */
interface InstructionInfo {
	/** インストラクションの内容 */
	content: string;
	/** 適用するプロンプトIDのリスト（undefinedは全プロンプトに適用） */
	targetPrompts?: string[];
}

/**
 * プロンプト提供サービス
 * 外部ファイルからのカスタムプロンプト読み込みと変数置換を担当
 */
export class PromptProvider {
	private static instance: PromptProvider | undefined;
	private readonly promptCache = new Map<string, string>();
	private instructionCache: InstructionInfo | null | undefined = undefined;

	private constructor() {}

	/**
	 * シングルトンインスタンスを取得
	 */
	public static getInstance(): PromptProvider {
		if (!PromptProvider.instance) {
			PromptProvider.instance = new PromptProvider();
		}
		return PromptProvider.instance;
	}

	/**
	 * シングルトンインスタンスを破棄（テスト用）
	 */
	public static dispose(): void {
		PromptProvider.instance?.clearCache();
		PromptProvider.instance = undefined;
	}

	/**
	 * キャッシュをクリア
	 */
	public clearCache(): void {
		this.promptCache.clear();
		this.instructionCache = undefined;
	}

	/**
	 * プロンプトを取得
	 * カスタムプロンプトが設定されていればそれを使用、なければデフォルトを使用
	 * インストラクションファイルが存在する場合は追加
	 *
	 * @param promptId プロンプトID
	 * @param variables 変数置換用のマッピング
	 * @returns 変数置換済みのプロンプト文字列
	 */
	public getPrompt(promptId: PromptId, variables: PromptVariables = {}): string {
		const parts = this.getPromptParts(promptId, variables);
		if (parts.isLegacy || !parts.userContext) {
			return parts.system;
		}
		return `${parts.system}\n\n${parts.userContext}`;
	}

	/**
	 * プロンプトを system / user-section に分割して取得
	 * テンプレート内の USER_SECTION_MARKER より前を system、後を userContext として
	 * それぞれ変数置換する。マーカーがないテンプレート（既存カスタムプロンプト等）は
	 * 従来の getPrompt と同一の結果を system に格納し、isLegacy: true を返す。
	 *
	 * @param promptId プロンプトID
	 * @param variables 変数置換用のマッピング
	 * @returns 分割済みプロンプト
	 */
	public getPromptParts(promptId: PromptId, variables: PromptVariables = {}): PromptParts {
		const template = this.getPromptTemplate(promptId);
		const instruction = this.getInstruction(promptId);
		const markerIndex = template.indexOf(USER_SECTION_MARKER);

		if (markerIndex === -1) {
			// レガシーテンプレート: 全体を system として扱う（従来挙動）
			let fullTemplate = template;
			if (instruction) {
				fullTemplate = `${fullTemplate}\n\n${instruction}`;
			}
			return {
				system: this.replaceVariables(fullTemplate, variables),
				userContext: "",
				isLegacy: true,
			};
		}

		// インストラクションは system 側の末尾に付与する（プレフィックスはセッション内で安定）
		let systemTemplate = template.slice(0, markerIndex).trimEnd();
		if (instruction) {
			systemTemplate = `${systemTemplate}\n\n${instruction}`;
		}
		const userTemplate = template.slice(markerIndex + USER_SECTION_MARKER.length);

		return {
			system: this.replaceVariables(systemTemplate, variables),
			userContext: this.replaceVariables(userTemplate, variables).trim(),
			isLegacy: false,
		};
	}

	/**
	 * プロンプトテンプレートを取得（変数置換なし）
	 *
	 * @param promptId プロンプトID
	 * @returns プロンプトテンプレート文字列
	 */
	private getPromptTemplate(promptId: PromptId): string {
		// キャッシュをチェック
		const cached = this.promptCache.get(promptId);
		if (cached !== undefined) {
			return cached;
		}

		// カスタムプロンプトのファイルパスを取得
		const customPath = this.getCustomPromptPath(promptId);

		if (customPath) {
			try {
				const customPrompt = this.loadPromptFile(customPath);
				this.promptCache.set(promptId, customPrompt);
				return customPrompt;
			} catch (error) {
				console.warn(`Failed to load custom prompt for ${promptId} from ${customPath}, using default:`, error);
			}
		}

		// デフォルトプロンプトを返す
		const defaultPrompt = DEFAULT_PROMPTS[promptId];
		if (!defaultPrompt) {
			throw new Error(`Unknown prompt ID: ${promptId}`);
		}

		this.promptCache.set(promptId, defaultPrompt);
		return defaultPrompt;
	}

	/**
	 * カスタムプロンプトのファイルパスを設定から取得
	 *
	 * @param promptId プロンプトID
	 * @returns ファイルパス（設定されていなければundefined）
	 */
	/**
	 * その指示文が利用者に上書きされているかを返す。
	 *
	 * **改訂パッチの読み方を決めるのに使う。** 上書きされた指示文は旧来の `=`/`-`/`+` 形式に
	 * 向けて書かれているので、その形式として読まなければならない（ADR-260903-01）。
	 * 読み込みに失敗して既定へ落ちた場合も「上書きあり」と答える — 落ちたことは
	 * `getPromptTemplate` が警告するが、形式の判断はファイルの有無で決める方が安全側に倒れる。
	 */
	public hasCustomPrompt(promptId: PromptId): boolean {
		return this.getCustomPromptPath(promptId) !== undefined;
	}

	private getCustomPromptPath(promptId: PromptId): string | undefined {
		const config = Configuration.getInstance();
		const promptsConfig = config.prompts;

		if (!promptsConfig) {
			return undefined;
		}

		// promptIdからネストされたキーを解決
		// 例: "trans.translate" -> prompts["trans.translate"]
		const relativePath = promptsConfig[promptId];
		if (!relativePath) {
			return undefined;
		}

		return path.join(config.getConfigBaseDir(), relativePath);
	}

	/**
	 * プロンプトファイルを読み込む
	 *
	 * @param filePath ファイルの絶対パス
	 * @returns ファイル内容
	 */
	private loadPromptFile(filePath: string): string {
		if (!fs.existsSync(filePath)) {
			throw new Error(`Prompt file not found: ${filePath}`);
		}

		return fs.readFileSync(filePath, "utf8");
	}

	/**
	 * インストラクションファイルのパスを取得
	 *
	 * @returns インストラクションファイルの絶対パス（ワークスペースがない場合はundefined）
	 */
	private getInstructionFilePath(): string | undefined {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot) {
			return undefined;
		}

		return path.join(Configuration.getInstance().getMdaitDir(), "mdait-instructions.md");
	}

	/**
	 * インストラクションファイルを読み込む
	 *
	 * @returns インストラクション情報（ファイルが存在しない場合はnull）
	 */
	private loadInstruction(): InstructionInfo | null {
		const filePath = this.getInstructionFilePath();
		if (!filePath || !fs.existsSync(filePath)) {
			return null;
		}

		try {
			const fileContent = fs.readFileSync(filePath, "utf8");
			const parsed = matter(fileContent);
			const frontMatter = parsed.data as InstructionFrontMatter;

			return {
				content: parsed.content.trim(),
				targetPrompts: frontMatter.prompts,
			};
		} catch (error) {
			console.warn("Failed to load instruction file:", error);
			return null;
		}
	}

	/**
	 * 指定されたプロンプトIDに対するインストラクションを取得
	 *
	 * @param promptId プロンプトID
	 * @returns インストラクション文字列（該当しない場合はundefined）
	 */
	private getInstruction(promptId: PromptId): string | undefined {
		// キャッシュをチェック（undefinedはまだ読み込んでいない状態）
		if (this.instructionCache === undefined) {
			this.instructionCache = this.loadInstruction();
		}

		// インストラクションが存在しない場合
		if (this.instructionCache === null) {
			return undefined;
		}

		// 対象プロンプトIDが指定されていない場合は全プロンプトに適用
		if (!this.instructionCache.targetPrompts) {
			return this.instructionCache.content;
		}

		// 指定されたプロンプトIDリストに含まれている場合のみ適用
		if (this.instructionCache.targetPrompts.includes(promptId)) {
			return this.instructionCache.content;
		}

		return undefined;
	}

	/**
	 * プロンプト内の変数を置換
	 * {{variable}} 形式のプレースホルダーを置換
	 * {{#variable}}...{{/variable}} 形式の条件ブロックも処理
	 *
	 * @param template プロンプトテンプレート
	 * @param variables 変数マッピング
	 * @returns 置換済みプロンプト
	 */
	private replaceVariables(template: string, variables: PromptVariables): string {
		let result = template;

		// 条件ブロックを処理: {{#variable}}...{{/variable}}
		// 変数が存在する場合はブロック内容を展開、なければブロック全体を削除
		result = result.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, key, content) => {
			const value = variables[key];
			if (value !== undefined && value !== "") {
				// ブロック内容を展開し、内部の変数も置換
				return content.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
			}
			return "";
		});

		// 単純変数置換: {{variable}}
		result = result.replace(/\{\{(\w+)\}\}/g, (_, key) => {
			const value = variables[key];
			return value !== undefined ? value : "";
		});

		return result;
	}
}
