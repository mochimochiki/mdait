import type * as vscode from "vscode";
import { Logger } from "../logging/logger";

/**
 * リトライ可能な一時的エラー（レート制限・サーバーエラー・タイムアウト等）を表す
 */
export class TransientHttpError extends Error {
	constructor(
		message: string,
		readonly status?: number,
		readonly retryAfterMs?: number,
	) {
		super(message);
		this.name = "TransientHttpError";
	}
}

/**
 * トランスポート層リトライのポリシー
 */
export interface RetryPolicy {
	/** 最大リトライ回数（初回試行を除く） */
	maxRetries: number;
	/** 初回バックオフ待機時間（ミリ秒） */
	initialDelayMs: number;
	/** バックオフ倍率 */
	multiplier: number;
	/** 待機時間の上限（Retry-Afterヘッダー指定値のクランプにも使用） */
	maxDelayMs: number;
}

/** デフォルトのリトライポリシー（2s → 4s → 8s、最大3回リトライ） */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
	maxRetries: 3,
	initialDelayMs: 2000,
	multiplier: 2,
	maxDelayMs: 60000,
};

/**
 * リトライ対象のHTTPステータスコードか判定する
 * 429（レート制限）と5xx（一時的なサーバーエラー）が対象
 */
export function isRetryableStatus(status: number): boolean {
	return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Retry-Afterヘッダー値をミリ秒に換算する
 * 秒数形式とHTTP-date形式の両方に対応。解釈できない値はundefinedを返す
 */
export function parseRetryAfterMs(headerValue: string | null): number | undefined {
	if (!headerValue) {
		return undefined;
	}

	const trimmed = headerValue.trim();
	if (/^\d+$/.test(trimmed)) {
		return Number.parseInt(trimmed, 10) * 1000;
	}

	const dateMs = Date.parse(trimmed);
	if (!Number.isNaN(dateMs)) {
		const deltaMs = dateMs - Date.now();
		return deltaMs > 0 ? deltaMs : 0;
	}

	return undefined;
}

/**
 * キャンセルに即応するsleep
 * 待機中にキャンセルされた場合は即座にrejectする
 */
export function delayWithCancellation(
	ms: number,
	token?: vscode.CancellationToken,
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (token?.isCancellationRequested) {
			reject(new Error("Operation cancelled"));
			return;
		}

		const timer = setTimeout(() => {
			subscription?.dispose();
			resolve();
		}, ms);

		const subscription = token?.onCancellationRequested(() => {
			clearTimeout(timer);
			subscription?.dispose();
			reject(new Error("Operation cancelled"));
		});
	});
}

/**
 * fetchのネットワーク起因エラー（DNS解決失敗・接続断等）か判定する
 * undiciはネットワークエラーをTypeError("fetch failed")としてrejectする
 */
function isNetworkError(error: unknown): boolean {
	return error instanceof TypeError;
}

export interface WithRetryOptions {
	policy?: Partial<RetryPolicy>;
	cancellationToken?: vscode.CancellationToken;
	/** リトライ対象エラーの判定。デフォルト: TransientHttpError またはネットワークエラー */
	isRetryable?: (error: unknown) => boolean;
	/** リトライ時のwarnログに付加するコンテキスト */
	logContext?: Record<string, unknown>;
}

/**
 * 一時的なエラーに対して指数バックオフでリトライしながら処理を実行する
 *
 * - TransientHttpError.retryAfterMs があればバックオフより優先して待機（maxDelayMsでクランプ）
 * - キャンセルされたら待機を打ち切って即中断
 * - リトライ対象外のエラー・リトライ上限超過時は最後のエラーをそのままthrow
 *
 * @param operation 実行する処理（attemptは0始まりの試行番号）
 * @param options リトライポリシー・キャンセルトークン等
 */
export async function withTransportRetry<T>(
	operation: (attempt: number) => Promise<T>,
	options?: WithRetryOptions,
): Promise<T> {
	const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...options?.policy };
	const isRetryable =
		options?.isRetryable ??
		((error: unknown) => error instanceof TransientHttpError || isNetworkError(error));
	const token = options?.cancellationToken;

	let lastError: unknown;
	for (let attempt = 0; attempt <= policy.maxRetries; attempt++) {
		if (token?.isCancellationRequested) {
			throw new Error("Operation cancelled");
		}

		try {
			return await operation(attempt);
		} catch (error) {
			lastError = error;

			if (attempt >= policy.maxRetries || !isRetryable(error)) {
				throw error;
			}

			const backoffMs = Math.min(
				policy.initialDelayMs * policy.multiplier ** attempt,
				policy.maxDelayMs,
			);
			const retryAfterMs =
				error instanceof TransientHttpError && error.retryAfterMs !== undefined
					? Math.min(error.retryAfterMs, policy.maxDelayMs)
					: undefined;
			const delayMs = retryAfterMs ?? backoffMs;

			Logger.getInstance().warn("llm", "Retrying after transient error", {
				attempt: attempt + 1,
				maxRetries: policy.maxRetries,
				delayMs,
				status: error instanceof TransientHttpError ? error.status : undefined,
				error: (error as Error)?.message ?? String(error),
				...options?.logContext,
			});

			await delayWithCancellation(delayMs, token);
		}
	}

	// maxRetries >= 0 のためここには到達しないが、型のためthrow
	throw lastError;
}
