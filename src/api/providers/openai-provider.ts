import type * as vscode from "vscode";
import type { AIConfig } from "../../config/configuration";
import type { AIMessage, AIService } from "../ai-service";
import { AIStatsLogger } from "../ai-stats-logger";

/**
 * OpenAI Chat Completions API 非ストリーミングレスポンスの型
 */
interface OpenAIChatCompletionResponse {
	choices?: Array<{
		message?: {
			role: string;
			content: string;
		};
		finish_reason?: string | null;
	}>;
}

/**
 * OpenAI Chat Completions APIを使用したAIプロバイダー実装。
 * fetchを使用して直接HTTPリクエストを送信します。
 */
export class OpenAIProvider implements AIService {
	private apiKey: string;
	private baseURL: string;
	private model: string;
	private maxOutputTokens: number;
	private timeoutMs: number;

	constructor(config: AIConfig) {
		// OpenAI固有設定を取得
		this.apiKey = (config.openai?.apiKey as string) || process.env.OPENAI_API_KEY || "";
		this.baseURL = (config.openai?.baseURL as string) || "https://api.openai.com/v1";
		this.model = (config.model as string) || "gpt-5-mini";
		this.maxOutputTokens = (config.openai?.maxTokens as number) ?? 2048;
		const timeoutSec = (config.openai?.timeoutSec as number) ?? 120;
		this.timeoutMs = timeoutSec * 1000;

		if (!this.apiKey) {
			throw new Error("OpenAI API key is not configured. Set openai.apiKey in OPENAI_API_KEY environment variable.");
		}
	}

	/**
	 * OpenAI Chat Completions APIに対してメッセージを送信し、応答を受け取ります。
	 *
	 * @param systemPrompt システムプロンプト（system roleのメッセージとして使用）
	 * @param messages メッセージ履歴
	 * @param cancellationToken キャンセル処理用トークン
	 * @returns 完全な応答テキスト
	 */
	async sendMessage(
		systemPrompt: string,
		messages: AIMessage[],
		cancellationToken?: vscode.CancellationToken,
	): Promise<string> {
		const startTime = Date.now();
		let outputChars = 0;
		let inputChars = 0;
		let status: "success" | "error" = "success";
		let errorMessage: string | undefined;
		let responseContent = "";

		// OpenAI Chat API の messages 配列に変換
		const openaiMessages: { role: string; content: string }[] = [];

		if (systemPrompt && systemPrompt.trim().length > 0) {
			openaiMessages.push({
				role: "system",
				content: systemPrompt,
			});
			inputChars += systemPrompt.length;
		}

		for (const msg of messages) {
			const content = typeof msg.content === "string" ? msg.content : msg.content.join("");
			inputChars += content.length;

			openaiMessages.push({
				role: msg.role,
				content,
			});
		}

		const url = this.baseURL.replace(/\/$/, "") + "/chat/completions";

		// AbortControllerを使用してキャンセル処理を実装
		const controller = new AbortController();
		const cancelSubscription = cancellationToken?.onCancellationRequested(() => {
			controller.abort();
			console.log("OpenAIProvider request was cancelled");
		});

		try {
			const response = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${this.apiKey}`,
				},
				body: JSON.stringify({
					model: this.model,
					messages: openaiMessages,
					stream: false,
					max_tokens: this.maxOutputTokens,
				}),
				signal: controller.signal,
			});

			if (!response.ok) {
				const text = await response.text().catch(() => "");
				status = "error";
				errorMessage = text || `HTTP error ${response.status} ${response.statusText}`;
				throw new Error(`OpenAI API error: ${errorMessage}`);
			}

			// 非ストリーミング応答の処理
			const data = (await response.json()) as OpenAIChatCompletionResponse;
			const content = data.choices?.[0]?.message?.content ?? "";

			responseContent = content;
			outputChars = content.length;

			return responseContent;
		} catch (error) {
			status = "error";

			// エラーの種類に応じた詳細メッセージを生成
			const unknownErr = error as { name?: string; message?: string };
			if (unknownErr?.name === "AbortError" || controller.signal.aborted) {
				errorMessage = "Request aborted";
			} else {
				errorMessage = (error as Error)?.message ?? String(error);
			}

			throw new Error(`OpenAI provider error: ${errorMessage}`);
		} finally {
			cancelSubscription?.dispose();
			// 統計情報をログに記録
			const durationMs = Date.now() - startTime;
			const logger = AIStatsLogger.getInstance();
			const timestamp = new Date().toLocaleString("sv-SE");

			await logger.log({
				timestamp,
				provider: "openai",
				model: this.model,
				inputChars,
				outputChars,
				durationMs,
				status,
				errorMessage,
			});

			// 詳細ログを記録（プロンプトと応答）
			await logger.logDetailed({
				timestamp,
				provider: "openai",
				model: this.model,
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
		}
	}
}
