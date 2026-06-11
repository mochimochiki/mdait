import { Ollama } from "ollama";
import type * as vscode from "vscode";
import type { AIConfig } from "../../config/configuration";
import { Logger } from "../../logging/logger";
import type { AIMessage, AIService } from "../ai-service";
import { AIStatsLogger } from "../ai-stats-logger";

/**
 * Ollama-js パッケージを使用した AI プロバイダー実装
 * ローカルで実行されるOllamaサーバーと通信してテキスト生成を行います
 */
export class OllamaProvider implements AIService {
	private ollama: Pick<Ollama, "generate" | "abort">;
	private model: string;
	private timeoutMs: number;

	constructor(config: AIConfig, ollamaClient?: Pick<Ollama, "generate" | "abort">) {
		// Ollama固有設定を優先、フォールバックとして汎用設定を使用
		const endpoint = (config.ollama?.endpoint as string) || "http://localhost:11434";
		this.model = (config.ollama?.model as string) || (config.model as string) || "llama2";
		const timeoutSec = (config.ollama?.timeoutSec as number) ?? 120;
		this.timeoutMs = timeoutSec * 1000;

		// Ollama クライアントを初期化（テスト用に外部注入可能）
		this.ollama = ollamaClient ?? new Ollama({ host: endpoint });
	}

	/**
	 * Promiseにタイムアウトを適用する
	 * 時間内に解決しなければonTimeoutで進行中のリクエストを中断し、rejectする
	 */
	private raceWithTimeout<T>(promise: Promise<T>, onTimeout: () => void): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				try {
					onTimeout();
				} catch {
					// abort失敗は無視（タイムアウトエラーを優先）
				}
				reject(
					new Error(
						`Ollama request timed out after ${this.timeoutMs / 1000}s (no response received)`,
					),
				);
			}, this.timeoutMs);

			promise.then(
				(value) => {
					clearTimeout(timer);
					resolve(value);
				},
				(error) => {
					clearTimeout(timer);
					reject(error);
				},
			);
		});
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
			Logger.getInstance().debug("llm", "Ollama request was cancelled");
		});

		try {
			// 開始前のキャンセルチェック
			if (cancellationToken?.isCancellationRequested) {
				status = "error";
				errorMessage = "Operation cancelled before start";
				throw new Error("Operation cancelled");
			}

			// Ollama-js パッケージを使用してストリーミング生成
			// サーバー無応答による無限待機を防ぐため初回応答にタイムアウトを適用
			const response = await this.raceWithTimeout(
				this.ollama.generate({
					model: this.model,
					prompt: prompt,
					stream: true,
					options: {
						temperature: 0.7,
						top_p: 0.9,
					},
				}),
				() => this.ollama.abort(),
			);

			// ストリーミングレスポンスを受信して結合
			// チャンク間にもタイムアウトを適用（途中でサーバーが固まった場合に中断）
			const iterator = response[Symbol.asyncIterator]();
			while (true) {
				const result = await this.raceWithTimeout(iterator.next(), () => response.abort());
				if (result.done) {
					break;
				}
				const part = result.value;
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
