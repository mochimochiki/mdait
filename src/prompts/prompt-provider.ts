/**
 * @file prompt-provider.ts
 * @description プロンプト提供サービス
 * デフォルトプロンプトと外部ファイルからのカスタムプロンプトを管理
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { Configuration } from "../config/configuration";
import { DEFAULT_PROMPTS, type PromptId } from "./defaults";

/**
 * プロンプト内の変数を表す型
 */
export type PromptVariables = Record<string, string | undefined>;

/**
 * プロンプト提供サービス
 * 外部ファイルからのカスタムプロンプト読み込みと変数置換を担当
 */
export class PromptProvider {
	private static instance: PromptProvider | undefined;
	private readonly promptCache = new Map<string, string>();

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
	}

	/**
	 * プロンプトを取得
	 * カスタムプロンプトが設定されていればそれを使用、なければデフォルトを使用
	 *
	 * @param promptId プロンプトID
	 * @param variables 変数置換用のマッピング
	 * @returns 変数置換済みのプロンプト文字列
	 */
	public getPrompt(promptId: PromptId, variables: PromptVariables = {}): string {
		// プロンプトテンプレートを取得
		const template = this.getPromptTemplate(promptId);

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
