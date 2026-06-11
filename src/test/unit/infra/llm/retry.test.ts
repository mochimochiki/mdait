import * as assert from "node:assert";
import type * as vscode from "vscode";
import {
	TransientHttpError,
	delayWithCancellation,
	isRetryableStatus,
	parseRetryAfterMs,
	withTransportRetry,
} from "../../../../infra/llm/retry";

/** テスト用の簡易キャンセルトークンを作成 */
function createFakeToken(): {
	token: vscode.CancellationToken;
	cancel: () => void;
} {
	let cancelled = false;
	const listeners: Array<() => void> = [];
	const token = {
		get isCancellationRequested() {
			return cancelled;
		},
		onCancellationRequested(listener: () => void) {
			listeners.push(listener);
			return {
				dispose() {
					const idx = listeners.indexOf(listener);
					if (idx >= 0) {
						listeners.splice(idx, 1);
					}
				},
			};
		},
	} as unknown as vscode.CancellationToken;

	return {
		token,
		cancel: () => {
			cancelled = true;
			for (const listener of [...listeners]) {
				listener();
			}
		},
	};
}

/** テスト高速化用のポリシー */
const FAST_POLICY = { maxRetries: 2, initialDelayMs: 1, multiplier: 2, maxDelayMs: 50 };

suite("isRetryableStatus", () => {
	test("429と5xxはリトライ対象", () => {
		assert.strictEqual(isRetryableStatus(429), true);
		assert.strictEqual(isRetryableStatus(500), true);
		assert.strictEqual(isRetryableStatus(503), true);
		assert.strictEqual(isRetryableStatus(599), true);
	});

	test("4xx（429以外）と2xxはリトライ対象外", () => {
		assert.strictEqual(isRetryableStatus(400), false);
		assert.strictEqual(isRetryableStatus(401), false);
		assert.strictEqual(isRetryableStatus(404), false);
		assert.strictEqual(isRetryableStatus(200), false);
	});
});

suite("parseRetryAfterMs", () => {
	test("秒数形式をms換算する", () => {
		assert.strictEqual(parseRetryAfterMs("5"), 5000);
		assert.strictEqual(parseRetryAfterMs("0"), 0);
	});

	test("HTTP-date形式を残り時間に換算する", () => {
		const future = new Date(Date.now() + 10000).toUTCString();
		const ms = parseRetryAfterMs(future);
		assert.ok(ms !== undefined && ms > 8000 && ms <= 10000, `unexpected: ${ms}`);
	});

	test("過去のHTTP-dateは0を返す", () => {
		const past = new Date(Date.now() - 10000).toUTCString();
		assert.strictEqual(parseRetryAfterMs(past), 0);
	});

	test("不正値・null はundefinedを返す", () => {
		assert.strictEqual(parseRetryAfterMs("abc"), undefined);
		assert.strictEqual(parseRetryAfterMs(null), undefined);
		assert.strictEqual(parseRetryAfterMs(""), undefined);
	});
});

suite("delayWithCancellation", () => {
	test("指定時間後に解決する", async () => {
		await delayWithCancellation(1);
	});

	test("待機中のキャンセルで即rejectする", async () => {
		const { token, cancel } = createFakeToken();
		const promise = delayWithCancellation(10000, token);
		setTimeout(cancel, 1);
		await assert.rejects(promise, /cancelled/i);
	});

	test("キャンセル済みトークンでは即rejectする", async () => {
		const { token, cancel } = createFakeToken();
		cancel();
		await assert.rejects(delayWithCancellation(1, token), /cancelled/i);
	});
});

suite("withTransportRetry", () => {
	test("初回成功時は1回で完了する", async () => {
		let calls = 0;
		const result = await withTransportRetry(
			async () => {
				calls++;
				return "ok";
			},
			{ policy: FAST_POLICY },
		);
		assert.strictEqual(result, "ok");
		assert.strictEqual(calls, 1);
	});

	test("429（TransientHttpError）はリトライして回復する", async () => {
		let calls = 0;
		const result = await withTransportRetry(
			async () => {
				calls++;
				if (calls === 1) {
					throw new TransientHttpError("rate limited", 429, 0);
				}
				return "recovered";
			},
			{ policy: FAST_POLICY },
		);
		assert.strictEqual(result, "recovered");
		assert.strictEqual(calls, 2);
	});

	test("503はリトライして回復する", async () => {
		let calls = 0;
		const result = await withTransportRetry(
			async () => {
				calls++;
				if (calls <= 2) {
					throw new TransientHttpError("unavailable", 503);
				}
				return "recovered";
			},
			{ policy: FAST_POLICY },
		);
		assert.strictEqual(result, "recovered");
		assert.strictEqual(calls, 3);
	});

	test("ネットワークエラー（TypeError）はリトライ対象", async () => {
		let calls = 0;
		const result = await withTransportRetry(
			async () => {
				calls++;
				if (calls === 1) {
					throw new TypeError("fetch failed");
				}
				return "recovered";
			},
			{ policy: FAST_POLICY },
		);
		assert.strictEqual(result, "recovered");
		assert.strictEqual(calls, 2);
	});

	test("非リトライ対象エラーは即throwする", async () => {
		let calls = 0;
		await assert.rejects(
			withTransportRetry(
				async () => {
					calls++;
					throw new Error("OpenAI API error: 401 Unauthorized");
				},
				{ policy: FAST_POLICY },
			),
			/401/,
		);
		assert.strictEqual(calls, 1);
	});

	test("リトライ上限超過で最後のエラーをthrowする", async () => {
		let calls = 0;
		await assert.rejects(
			withTransportRetry(
				async () => {
					calls++;
					throw new TransientHttpError("persistent failure", 500);
				},
				{ policy: FAST_POLICY },
			),
			/persistent failure/,
		);
		// 初回 + maxRetries(2) = 3試行
		assert.strictEqual(calls, 3);
	});

	test("バックオフ待機中のキャンセルで即中断する", async () => {
		const { token, cancel } = createFakeToken();
		let calls = 0;
		const promise = withTransportRetry(
			async () => {
				calls++;
				throw new TransientHttpError("rate limited", 429, 60000);
			},
			{ policy: { ...FAST_POLICY, maxDelayMs: 60000 }, cancellationToken: token },
		);
		setTimeout(cancel, 5);
		await assert.rejects(promise, /cancelled/i);
		assert.strictEqual(calls, 1);
	});

	test("maxRetriesが負数でも必ず1回は試行され実際のエラーがthrowされる", async () => {
		let calls = 0;
		await assert.rejects(
			withTransportRetry(
				async () => {
					calls++;
					throw new Error("actual failure");
				},
				{ policy: { ...FAST_POLICY, maxRetries: -1 } },
			),
			/actual failure/,
		);
		assert.strictEqual(calls, 1);
	});

	test("maxRetriesがNaNの場合はデフォルト値で動作する", async () => {
		let calls = 0;
		const result = await withTransportRetry(
			async () => {
				calls++;
				if (calls === 1) {
					throw new TransientHttpError("transient", 503, 0);
				}
				return "ok";
			},
			{ policy: { ...FAST_POLICY, maxRetries: Number.NaN } },
		);
		assert.strictEqual(result, "ok");
		assert.strictEqual(calls, 2);
	});

	test("Retry-Afterが指定されていればmaxDelayMsでクランプされる", async () => {
		let calls = 0;
		const start = Date.now();
		await withTransportRetry(
			async () => {
				calls++;
				if (calls === 1) {
					// 巨大なRetry-AfterはmaxDelayMs(50ms)にクランプされる
					throw new TransientHttpError("rate limited", 429, 600000);
				}
				return "ok";
			},
			{ policy: FAST_POLICY },
		);
		const elapsed = Date.now() - start;
		assert.ok(elapsed < 5000, `clamp not applied: ${elapsed}ms`);
	});
});
