import OpenAI from "openai";
import type * as vscode from "vscode";
import type { AIConfig } from "../../config/configuration";
import type { AIMessage, AIService } from "../ai-service";
import { AIStatsLogger } from "../ai-stats-logger";

/**
 * OpenAI Responses APIを使用したAIプロバイダー実装。
 * 公式のopenai SDKを使用して応答を受け取ります。
 */
export class OpenAIProvider implements AIService {
	private client: OpenAI;
	private model: string;
	private maxOutputTokens: number;
	private timeoutMs: number;

	constructor(config: AIConfig) {
		// OpenAI固有設定を取得
		const apiKey = (config.openai?.apiKey as string) || process.env.OPENAI_API_KEY;
		const baseURL = config.openai?.baseURL as string | undefined;
		this.model = (config.model as string) || "gpt-5-mini";
		this.maxOutputTokens = (config.openai?.maxTokens as number) ?? 2048;
		const timeoutSec = (config.openai?.timeoutSec as number) ?? 120;
		this.timeoutMs = timeoutSec * 1000;

		if (!apiKey) {
			throw new Error(
				"OpenAI API key is not configured. Set openai.apiKey in mdait.json or OPENAI_API_KEY environment variable.",
			);
		}

		// OpenAI クライアントを初期化
		this.client = new OpenAI({
			apiKey,
			baseURL,
			timeout: this.timeoutMs,
		});
	}

	/**
	 * OpenAI Responses APIに対してメッセージを送信し、応答を受け取ります。
	 *
	 * @param systemPrompt システムプロンプト（instructionsとして使用）
	 * @param messages メッセージ履歴（inputとして使用）
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
		let status: "success" | "error" = "success";
		let errorMessage: string | undefined;
		let responseContent = "";

		// AbortControllerを使用してキャンセル処理を実装
		const abortController = new AbortController();
		const cancelSubscription = cancellationToken?.onCancellationRequested(() => {
			abortController.abort();
		});

		// Responses API形式にメッセージを変換（system役割は除外）
		const input = messages.map((msg) => ({
			role: msg.role as "user" | "assistant",
			content: typeof msg.content === "string" ? msg.content : msg.content.join("\n"),
		}));

		// 入力文字数の計測
		const inputChars = (systemPrompt?.length ?? 0) + input.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);

		try {
			// OpenAI Responses APIを非ストリーミングモードで呼び出し
			const response = await this.client.responses.create(
				{
					model: this.model,
					instructions: systemPrompt,
					input,
					stream: false,
					temperature: 0.7,
					reasoning: { effort: "low" },
					max_output_tokens: this.maxOutputTokens,
					store: false,
				},
				{
					signal: abortController.signal,
				},
			);

			// 応答からテキストを抽出
			for (const item of response.output) {
				if (item.type === "message" && item.content) {
					for (const content of item.content) {
						if (content.type === "output_text") {
							responseContent += content.text;
						}
					}
				}
			}
			outputChars = responseContent.length;

			return responseContent;
		} catch (error) {
			status = "error";

			// エラーの種類に応じた詳細メッセージを生成
			const unknownErr = error as { name?: string; status?: number; type?: string; message?: string };
			if (unknownErr?.name === "AbortError" || abortController.signal.aborted) {
				errorMessage = "Request aborted";
			} else if (unknownErr?.status || unknownErr?.type) {
				const details = `Status: ${unknownErr.status ?? "?"}, Type: ${unknownErr.type ?? "?"}`;
				errorMessage = `${unknownErr.message ?? String(error)} (${details})`;
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
