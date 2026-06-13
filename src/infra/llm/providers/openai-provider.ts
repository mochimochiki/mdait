import type * as vscode from "vscode";
import { calculateHash } from "../../../core/hash/hash-calculator";
import type { AIConfig } from "../../config/configuration";
import { Logger } from "../../logging/logger";
import type { AIMessage, AIService } from "../ai-service";
import { AIStatsLogger } from "../ai-stats-logger";
import {
	type RetryPolicy,
	TransientHttpError,
	isRetryableStatus,
	parseRetryAfterMs,
	withTransportRetry,
} from "../retry";

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
	usage?: OpenAIUsage;
}

/**
 * OpenAI API の usage フィールドの型
 * cached_tokens でプロンプトキャッシュのヒット状況を確認できる
 */
interface OpenAIUsage {
	prompt_tokens?: number;
	completion_tokens?: number;
	prompt_tokens_details?: {
		cached_tokens?: number;
	};
}

/** performRequest の戻り値（応答本文とトークン使用量） */
interface OpenAIRequestResult {
	content: string;
	usage?: OpenAIUsage;
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
	private retryPolicy: Partial<RetryPolicy> | undefined;

	constructor(config: AIConfig, retryPolicy?: Partial<RetryPolicy>) {
		this.retryPolicy = retryPolicy;
		// OpenAI固有設定を取得
		this.apiKey = (config.openai?.apiKey as string) || process.env.OPENAI_API_KEY || "";
		this.baseURL = (config.openai?.baseURL as string) || "https://api.openai.com/v1";
		this.model = (config.model as string) || "gpt-5-mini";
		this.maxOutputTokens = (config.openai?.maxTokens as number) ?? 16384;
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
		let usage: OpenAIUsage | undefined;

		// プロンプトキャッシュのルーティングを安定させるキー
		// system prompt はテンプレート×言語ペア単位で固定のため、そのハッシュが自然な単位になる
		const promptCacheKey = `mdait-${calculateHash(systemPrompt)}`;

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

		try {
			// 429/5xx・ネットワークエラー・タイムアウトは指数バックオフでリトライする
			const result = await withTransportRetry(
				() =>
					this.performRequest(openaiMessages, promptCacheKey, cancellationToken),
				{
					policy: this.retryPolicy,
					cancellationToken,
					logContext: { provider: "openai", model: this.model },
				},
			);
			responseContent = result.content;
			usage = result.usage;
			outputChars = responseContent.length;

			if (usage) {
				Logger.getInstance().debug("llm", "OpenAI token usage", {
					promptTokens: usage.prompt_tokens,
					cachedTokens: usage.prompt_tokens_details?.cached_tokens,
					completionTokens: usage.completion_tokens,
				});
			}

			return responseContent;
		} catch (error) {
			status = "error";
			errorMessage = (error as Error)?.message ?? String(error);
			throw new Error(`OpenAI provider error: ${errorMessage}`);
		} finally {
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
				promptTokens: usage?.prompt_tokens,
				cachedTokens: usage?.prompt_tokens_details?.cached_tokens,
				completionTokens: usage?.completion_tokens,
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

	/**
	 * Chat Completions APIへの1試行分のリクエストを実行する
	 * リトライ可能な失敗（429/5xx/タイムアウト）は TransientHttpError としてthrowする
	 */
	private async performRequest(
		openaiMessages: { role: string; content: string }[],
		promptCacheKey: string,
		cancellationToken?: vscode.CancellationToken,
	): Promise<OpenAIRequestResult> {
		const url = `${this.baseURL.replace(/\/$/, "")}/chat/completions`;

		// AbortControllerは再利用できないため試行ごとに生成する
		const controller = new AbortController();
		let timedOut = false;
		const timeoutTimer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, this.timeoutMs);
		const cancelSubscription = cancellationToken?.onCancellationRequested(() => {
			controller.abort();
			Logger.getInstance().debug("llm", "OpenAI request was cancelled");
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
					store: false,
					max_completion_tokens: this.maxOutputTokens,
					// 安定したキーを渡すことでプロンプトキャッシュのヒット率を高める
					// （同一プレフィックスのリクエストが同じ推論ノードへルーティングされやすくなる）
					prompt_cache_key: promptCacheKey,
				}),
				signal: controller.signal,
			});

			if (!response.ok) {
				const text = await response.text().catch(() => "");
				const message = text || `HTTP error ${response.status} ${response.statusText}`;
				if (isRetryableStatus(response.status)) {
					throw new TransientHttpError(
						`OpenAI API error: ${message}`,
						response.status,
						parseRetryAfterMs(response.headers.get("retry-after")),
					);
				}
				throw new Error(`OpenAI API error: ${message}`);
			}

			// 非ストリーミング応答の処理
			const data = (await response.json()) as OpenAIChatCompletionResponse;
			return {
				content: data.choices?.[0]?.message?.content ?? "",
				usage: data.usage,
			};
		} catch (error) {
			const unknownErr = error as { name?: string; message?: string };
			if (unknownErr?.name === "AbortError" || controller.signal.aborted) {
				if (timedOut) {
					// タイムアウト起因のabortは一時的エラーとしてリトライ対象にする
					throw new TransientHttpError(
						`Request timed out after ${this.timeoutMs / 1000}s`,
					);
				}
				// ユーザーキャンセル起因のabortはリトライしない
				throw new Error("Request aborted");
			}
			throw error;
		} finally {
			clearTimeout(timeoutTimer);
			cancelSubscription?.dispose();
		}
	}
}
