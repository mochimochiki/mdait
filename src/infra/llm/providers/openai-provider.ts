import * as vscode from "vscode";
import { calculateHash } from "../../../core/hash/hash-calculator";
import type { AIConfig } from "../../config/configuration";
import { OperationCancelledError, rethrowIfCancelled } from "../../errors/operation-cancelled";
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
import { UnusableAIResponseError, isUnusableAIResponse } from "../unusable-response";

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
 * エラー応答の本文から、人が読む一文を取り出す。
 *
 * OpenAI 互換のサーバーは `{"error":{"message":"..."}}` を返す。本文をそのまま繋ぐと
 * トーストに生の JSON が出て、読むべき一文（「そのモデルは無い」「キーが違う」）が
 * 入れ子の中に埋まる。1行しか見えない場所なので、`message` だけを取り出す。
 * 形が違えば本文をそのまま返す（勝手に捨てない）。
 *
 * @param body 応答本文
 * @param status HTTP ステータス
 * @param statusText HTTP ステータスの語
 */
export function describeApiError(body: string, status: number, statusText: string): string {
	if (body) {
		try {
			const parsed = JSON.parse(body) as { error?: { message?: unknown } };
			const message = parsed?.error?.message;
			if (typeof message === "string" && message.trim() !== "") {
				return `OpenAI API error (${status}): ${message}`;
			}
		} catch {
			// JSON でなければ本文をそのまま使う
		}
		return `OpenAI API error: ${body}`;
	}
	return `OpenAI API error: HTTP error ${status} ${statusText}`;
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
			// 診断（doctor）が出すのと同じ文にそろえる。初回にいちばん多い詰まり方なので、
			// 押した場所で言うことが違うと「どちらが本当か」を確かめる手数が増える
			throw new Error(
				vscode.l10n.t(
					"OpenAI API key is not set. Configure openai.apiKey or the OPENAI_API_KEY environment variable.",
				),
			);
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
		// system prompt はテンプレート単位で固定（言語指定はuser message側）のため、そのハッシュが自然な単位になる
		// 正規化なしでハッシュ化し、異なるsystem promptが同一キーに畳まれないようにする
		const promptCacheKey = `mdait-${calculateHash(systemPrompt, false)}`;

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
			// 中断はプロバイダ名でラップしない。ラップすると名前が Error になって
			// 受け手が「失敗」と区別できず、正常な中断が赤いエラー通知になる
			rethrowIfCancelled(error);
			// 「答えたが使えない」も同じ理由でラップしない。ラップすると型が消えて、
			// 呼び出し側が「AI に届かなかった」失敗と区別できなくなる
			if (isUnusableAIResponse(error)) {
				throw error;
			}
			// 既に "OpenAI ..." で始まる文をもう一度包まない。
			// 包むと「provider error: API error: {…}」と接頭辞が二重になり、
			// トーストの1行に収まる範囲から肝心の理由が押し出される
			throw new Error(
				errorMessage.startsWith("OpenAI ") ? errorMessage : `OpenAI provider error: ${errorMessage}`,
			);
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
				const message = describeApiError(text, response.status, response.statusText);
				if (isRetryableStatus(response.status)) {
					throw new TransientHttpError(
						message,
						response.status,
						parseRetryAfterMs(response.headers.get("retry-after")),
					);
				}
				throw new Error(message);
			}

			// 非ストリーミング応答の処理
			const data = (await response.json()) as OpenAIChatCompletionResponse;
			const choice = data.choices?.[0];
			const content = choice?.message?.content ?? "";

			// 出力上限に当たって途中で切れた答えは**使えない**。ここで断ち切る。
			//
			// 送り直さない: finish_reason: "length" は相手が落ちているのではなく、
			// こちらが渡した上限に当たったということなので、同じ要求を送れば同じところで
			// 切れる。429/503 のような一時的な失敗ではないため、待って送り直すのは
			// 費用と時間を捨てるだけになる（実測: 台本を繰り返す相手に当てると、
			// 送り直しのたびに同じ位置で切れた文字列が返る）。
			//
			// 推論する型のモデル（既定の gpt-5-mini など）では、考えている分の
			// トークンも max_completion_tokens に数えられる。使い切ると **本文が空のまま**
			// finish_reason: "length" で返ることがあり、これを「空の答え」として扱うと
			// 「上限を上げれば直る」という肝心の手掛かりが失われる。だから空かどうかより
			// 先に finish_reason を見る。
			if (choice?.finish_reason === "length") {
				throw new UnusableAIResponseError(
					"truncated",
					`OpenAI response was cut off at the output limit (max_completion_tokens=${this.maxOutputTokens})`,
					`outputChars=${content.length}`,
				);
			}

			return {
				content,
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
				// ユーザーキャンセル起因のabortはリトライしない。
				// 失敗ではなく中断として扱わせるため専用の型で投げる
				throw new OperationCancelledError("Request aborted");
			}
			throw error;
		} finally {
			clearTimeout(timeoutTimer);
			cancelSubscription?.dispose();
		}
	}
}
