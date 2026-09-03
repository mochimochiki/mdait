import { Ollama } from "ollama";
import type * as vscode from "vscode";
import type { AIConfig } from "../../config/configuration";
import { OperationCancelledError, rethrowIfCancelled } from "../../errors/operation-cancelled";
import { Logger } from "../../logging/logger";
import type { AIMessage, AIService } from "../ai-service";
import { AIStatsLogger } from "../ai-stats-logger";
import { UnusableAIResponseError, isUnusableAIResponse } from "../unusable-response";

/**
 * Ollama-js パッケージを使用した AI プロバイダー実装
 * ローカルで実行されるOllamaサーバーと通信してテキスト生成を行います
 */
export class OllamaProvider implements AIService {
	private ollama: Pick<Ollama, "chat" | "abort">;
	private model: string;
	private timeoutMs: number;
	private keepAlive?: string | number;

	constructor(config: AIConfig, ollamaClient?: Pick<Ollama, "chat" | "abort">) {
		// Ollama固有設定を優先、フォールバックとして汎用設定を使用
		const endpoint = (config.ollama?.endpoint as string) || "http://localhost:11434";
		this.model = (config.ollama?.model as string) || (config.model as string) || "llama2";
		const timeoutSec = (config.ollama?.timeoutSec as number) ?? 120;
		this.timeoutMs = timeoutSec * 1000;
		this.keepAlive = config.ollama?.keepAlive;

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
				reject(new Error(`Ollama request timed out after ${this.timeoutMs / 1000}s (no response or stalled stream)`));
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
		let promptTokens: number | undefined;
		let completionTokens: number | undefined;

		// chat API 用のメッセージ配列を構築
		// systemロールを分離することでモデルのchatテンプレートが正しく適用され、
		// 静的なsystem prompt部分のkv-cacheがリクエスト間で再利用される
		const chatMessages: { role: string; content: string }[] = [];
		if (systemPrompt) {
			chatMessages.push({ role: "system", content: systemPrompt });
		}
		for (const msg of messages) {
			const content = Array.isArray(msg.content) ? msg.content.join("") : msg.content;
			chatMessages.push({ role: msg.role, content });
		}
		const inputChars = chatMessages.reduce((sum, msg) => sum + msg.content.length, 0);

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
				throw new OperationCancelledError();
			}

			// Ollama-js パッケージを使用してストリーミング生成
			// サーバー無応答による無限待機を防ぐため初回応答にタイムアウトを適用
			const response = await this.raceWithTimeout(
				this.ollama.chat({
					model: this.model,
					messages: chatMessages,
					stream: true,
					// 設定がある場合のみ送信し、未指定時はサーバー既定値（5分）に従う
					...(this.keepAlive !== undefined ? { keep_alive: this.keepAlive } : {}),
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
				if (part.message?.content) {
					responseContent += part.message.content;
				}
				// done フラグで終了判定（最終チャンクにトークン使用量が含まれる）
				if (part.done) {
					promptTokens = part.prompt_eval_count;
					completionTokens = part.eval_count;
					// 出力上限で打ち切られた答えは使えない（OpenAI 経路の finish_reason: "length" と同じ）。
					// 途中で切れた JSON を訳文として採用させないため、ここで断ち切る
					const doneReason = (part as { done_reason?: string }).done_reason;
					if (doneReason === "length") {
						throw new UnusableAIResponseError(
							"truncated",
							"Ollama response was cut off at the output limit (num_predict)",
							`outputChars=${responseContent.length}`,
						);
					}
					break;
				}
			}

			outputChars = responseContent.length;

			// 応答後のキャンセルチェック
			if (cancellationToken?.isCancellationRequested) {
				status = "error";
				errorMessage = "Operation cancelled after completion";
				throw new OperationCancelledError();
			}

			return responseContent;
		} catch (error) {
			// キャンセル以外のエラーの場合のみ status を上書き
			if (status !== "error" || !errorMessage) {
				status = "error";
				errorMessage = (error as Error).message;
			}
			// 中断はプロバイダ名でラップしない。ラップすると受け手が「失敗」と
			// 区別できず、正常な中断が赤いエラー通知になる
			rethrowIfCancelled(error);
			// 「答えたが使えない」もラップしない（型が消えると呼び出し側が区別できない）
			if (isUnusableAIResponse(error)) {
				throw error;
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
				promptTokens,
				completionTokens,
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
