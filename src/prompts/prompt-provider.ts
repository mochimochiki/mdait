/**
 * @file prompt-provider.ts
 * @description プロンプト提供サービス
 * デフォルトプロンプトと外部ファイルからのカスタムプロンプトを管理
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import matter from "gray-matter";
import { Configuration } from "../config/configuration";
import { DEFAULT_PROMPTS, type PromptId } from "./defaults";

/**
 * プロンプト内の変数を表す型
 */
export type PromptVariables = Record<string, string | undefined>;

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
		// プロンプトテンプレートを取得
		let template = this.getPromptTemplate(promptId);

		// インストラクションを追加
		const instruction = this.getInstruction(promptId);
		if (instruction) {
			template = `${template}\n\n${instruction}`;
		}

		// 変数を置換して返す
		return this.replaceVariables(template, variables);
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

		// ワークスペースルートからの相対パスを絶対パスに変換
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot) {
			return undefined;
		}

		return path.join(workspaceRoot, relativePath);
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

		return path.join(workspaceRoot, ".mdait", "mdait-instruction.md");
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
