import { Ollama } from "ollama";
import type * as vscode from "vscode";
import type { AIConfig } from "../../config/configuration";
import type { AIMessage, AIService, MessageStream } from "../ai-service";
import { AIStatsLogger } from "../ai-stats-logger";

/**
 * Ollama-js パッケージを使用した AI プロバイダー実装
 * ローカルで実行されるOllamaサーバーと通信してテキスト生成を行います
 */
export class OllamaProvider implements AIService {
	private ollama: Ollama;
	private model: string;

	constructor(config: AIConfig) {
		// Ollama固有設定を優先、フォールバックとして汎用設定を使用
		const endpoint = (config.ollama?.endpoint as string) || "http://localhost:11434";
		this.model = (config.ollama?.model as string) || (config.model as string) || "llama2";

		// Ollama クライアントを初期化
		this.ollama = new Ollama({ host: endpoint });
	}
	/**
	 * Ollamaサーバーに対してメッセージを送信し、ストリーミング応答を受け取ります。
	 *
	 * @param systemPrompt システムプロンプト
	 * @param messages メッセージ履歴
	 * @param cancellationToken キャンセル処理用トークン
	 * @returns ストリーミング応答のAsyncGenerator
	 */
	async *sendMessage(
		systemPrompt: string,
		messages: AIMessage[],
		cancellationToken?: vscode.CancellationToken,
	): MessageStream {
		const startTime = Date.now();
		let outputChars = 0;
		let status: "success" | "error" = "success";
		let errorMessage: string | undefined;

		// ユーザーメッセージを取得
		const userMessage = messages.find((msg) => msg.role === "user");
		const userContent = (userMessage?.content as string) || "";

		// システムプロンプトとユーザーメッセージを結合
		const prompt = systemPrompt ? `${systemPrompt}\n\n${userContent}` : userContent;
		const inputChars = prompt.length;

		try {
			// Ollama-js パッケージを使用してストリーミング生成
			const stream = await this.ollama.generate({
				model: this.model,
				prompt: prompt,
				stream: true,
				options: {
					temperature: 0.7,
					top_p: 0.9,
				},
			});

			// CancellationTokenと連携してAbortableAsyncIteratorを中断
			if (cancellationToken) {
				cancellationToken.onCancellationRequested(() => {
					stream.abort();
					console.log("Ollama request was cancelled");
				});
			}

			// ストリーミングレスポンスを処理
			for await (const chunk of stream) {
				if (chunk.response) {
					outputChars += chunk.response.length;
					yield chunk.response;
				}
				if (chunk.done) {
					break;
				}
			}
		} catch (error) {
			status = "error";
			errorMessage = (error as Error).message;
			throw new Error(`Ollama provider error: ${(error as Error).message}`);
		} finally {
			// 統計情報をログに記録
			const durationMs = Date.now() - startTime;
			const logger = AIStatsLogger.getInstance();
			await logger.log({
				timestamp: new Date().toISOString(),
				provider: "ollama",
				model: this.model,
				inputChars,
				outputChars,
				durationMs,
				status,
				errorMessage,
			});
		}
	}
}
