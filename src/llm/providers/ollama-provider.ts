import { Ollama } from "ollama";
import type * as vscode from "vscode";
import type { AIConfig } from "../../config/configuration";
import type { AIMessage, AIService } from "../ai-service";
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
	 * Ollamaサーバーに対してメッセージを送信し、応答を受け取ります。
	 *
	 * @param systemPrompt システムプロンプト
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
		let status: "success" | "error" = "success";
		let errorMessage: string | undefined;
		let responseContent = "";

		// ユーザーメッセージを取得
		const userMessage = messages.find((msg) => msg.role === "user");
		const userContent = (userMessage?.content as string) || "";

		// システムプロンプトとユーザーメッセージを結合
		const prompt = systemPrompt ? `${systemPrompt}\n\n${userContent}` : userContent;
		const inputChars = prompt.length;

		// キャンセル処理の設定
		const cancelSubscription = cancellationToken?.onCancellationRequested(() => {
			this.ollama.abort();
			console.log("Ollama request was cancelled (abort())");
		});

		try {
			// 開始前のキャンセルチェック
			if (cancellationToken?.isCancellationRequested) {
				status = "error";
				errorMessage = "Operation cancelled before start";
				throw new Error("Operation cancelled");
			}

			// Ollama-js パッケージを使用してストリーミング生成
			const response = await this.ollama.generate({
				model: this.model,
				prompt: prompt,
				stream: true,
				options: {
					temperature: 0.7,
					top_p: 0.9,
				},
			});

			// ストリーミングレスポンスを受信して結合
			for await (const part of response) {
				if (part.response) {
					responseContent += part.response;
				}
				// done フラグで終了判定
				if (part.done) {
					break;
				}
			}

			outputChars = responseContent.length;

			// 応答後のキャンセルチェック
			if (cancellationToken?.isCancellationRequested) {
				status = "error";
				errorMessage = "Operation cancelled after completion";
				throw new Error("Operation cancelled");
			}

			return responseContent;
		} catch (error) {
			// キャンセル以外のエラーの場合のみ status を上書き
			if (status !== "error" || !errorMessage) {
				status = "error";
				errorMessage = (error as Error).message;
			}
			throw new Error(`Ollama provider error: ${(error as Error).message}`);
		} finally {
			// キャンセルリスナーのクリーンアップ
			cancelSubscription?.dispose();
			// 統計情報をログに記録
			const durationMs = Date.now() - startTime;
			const logger = AIStatsLogger.getInstance();
			const timestamp = new Date().toLocaleString("sv-SE");

			await logger.log({
				timestamp,
				provider: "ollama",
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
				provider: "ollama",
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
