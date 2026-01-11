import type * as vscode from "vscode";
import type { AIConfig } from "../../config/configuration";
import type { AIMessage, AIService } from "../ai-service";
import { AIStatsLogger } from "../ai-stats-logger";

/**
 * AIServiceインターフェースのデフォルト実装（モック）。
 * 実際のAIプロバイダへの接続は行わず、固定の応答またはエコーバックを返します。
 * 主に開発初期段階やテスト用途での使用を想定しています。
 */
export class DefaultAIProvider implements AIService {
	private config: AIConfig;

	constructor(config: AIConfig) {
		this.config = config;
		console.log("DefaultAIProvider initialized with config:", config);
	}
	/**
	 * AIモデルに対してメッセージを送信し、応答を受け取ります。
	 * このデフォルト実装では、簡易的な翻訳モック応答を返します。
	 *
	 * @param systemPrompt システムプロンプト。
	 * @param messages AIモデルに送信するメッセージの配列。
	 * @param _cancellationToken キャンセル処理用トークン（未使用）
	 * @returns モックの応答テキスト。
	 */
	async sendMessage(
		systemPrompt: string,
		messages: AIMessage[],
		_cancellationToken?: vscode.CancellationToken,
	): Promise<string> {
		const startTime = Date.now();
		const status: "success" | "error" = "success";
		const errorMessage: string | undefined = undefined;

		console.log(`DefaultAIProvider.sendMessage called with systemPrompt: ${systemPrompt}`);
		console.log(`DefaultAIProvider.sendMessage called with messages: ${JSON.stringify(messages, null, 2)}`);

		// 翻訳対象のテキストを取得
		const userMessage = messages.find((msg) => msg.role === "user");
		const textToTranslate = (userMessage?.content as string) || "";

		// 入力文字数の計測
		const inputChars = systemPrompt.length + textToTranslate.length;

		// 簡易的な翻訳モック処理
		// 実際のAIプロバイダーでは、ここでAPIリクエストを行います
		const responseContent = this.generateMockTranslation(textToTranslate, systemPrompt);
		const outputChars = responseContent.length;

		// 統計情報をログに記録
		const durationMs = Date.now() - startTime;
		const logger = AIStatsLogger.getInstance();
		const timestamp = new Date().toLocaleString("sv-SE");

		await logger.log({
			timestamp,
			provider: "default",
			model: this.config.model || "mock",
			inputChars,
			outputChars,
			durationMs,
			status,
			errorMessage,
		});

		// 詳細ログを記録（プロンプトと応答）
		await logger.logDetailed({
			timestamp,
			provider: "default",
			model: this.config.model || "mock",
			request: {
				systemPrompt,
				messages,
			},
			response: {
				content: responseContent,
				durationMs,
			},
			status,
			errorMessage,
		});

		return responseContent;
	}
	/**
	 * 簡易的な翻訳モックを生成します。
	 */
	private generateMockTranslation(text: string, systemPrompt: string): string {
		// systemPromptから言語ペアを抽出
		const fromMatch = systemPrompt.match(/from (\w+)/);
		const toMatch = systemPrompt.match(/to (\w+)/);
		const sourceLang = fromMatch?.[1] || "auto";
		const targetLang = toMatch?.[1] || "ja";

		// 言語ペアに応じた翻訳パターン
		if (sourceLang === "ja" && targetLang === "en") {
			return `${text
				.replace(/こんにちは/g, "Hello")
				.replace(/世界/g, "World")
				.replace(/ありがとう/g, "Thank you")
				.replace(/おはよう/g, "Good morning")
				.replace(/こんばんは/g, "Good evening")
				.replace(/元気ですか/g, "How are you")
				.replace(/です/g, "is")}\n\n[Mock translation by DefaultAIProvider: ${sourceLang} → ${targetLang}]`;
		}

		if ((sourceLang === "en" || sourceLang === "auto") && targetLang === "ja") {
			return `${text
				.replace(/Hello/gi, "こんにちは")
				.replace(/World/gi, "世界")
				.replace(/Thank you/gi, "ありがとう")
				.replace(/Good morning/gi, "おはよう")
				.replace(/Good evening/gi, "こんばんは")
				.replace(/How are you/gi, "元気ですか")
				.replace(/The/gi, "その")
				.replace(/is/gi, "です")
				.replace(/are/gi, "です")}\n\n[DefaultAIProviderによるモック翻訳: ${sourceLang} → ${targetLang}]`;
		}

		// その他の言語ペアの場合
		return `${text}\n\n[DefaultAIProviderによるモック翻訳: ${sourceLang} → ${targetLang}]`;
	}
}
