import * as assert from "node:assert";
import type * as vscode from "vscode";
import type { AIConfig } from "../../../../infra/config/configuration";
import { Configuration } from "../../../../infra/config/configuration";
import { OpenAIProvider } from "../../../../infra/llm/providers/openai-provider";

/** テスト用AIConfig */
function createConfig(): AIConfig {
	return {
		provider: "openai",
		model: "gpt-test",
		ollama: { endpoint: "http://localhost:11434", model: "llama2" },
		openai: { apiKey: "test-key", timeoutSec: 5 },
	};
}

/** チャット応答のモックResponseを作成 */
function okResponse(content: string): Response {
	return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

/** エラーレスポンスを作成 */
function errorResponse(status: number, headers?: Record<string, string>): Response {
	return new Response("error body", { status, headers });
}

/** テスト高速化用のリトライポリシー */
const FAST_POLICY = { maxRetries: 2, initialDelayMs: 1, multiplier: 2, maxDelayMs: 50 };

suite("OpenAIProvider", () => {
	let originalFetch: typeof globalThis.fetch;
	let fetchCalls: number;

	setup(() => {
		originalFetch = globalThis.fetch;
		fetchCalls = 0;
		// 統計ログのファイル書き込みを抑止
		Configuration.dispose();
		const config = Configuration.getInstance();
		config.ai.debug = { enableStatsLogging: false, logPromptAndResponse: false };
	});

	teardown(() => {
		globalThis.fetch = originalFetch;
		Configuration.dispose();
	});

	function stubFetch(handler: (call: number) => Response | Promise<Response>): void {
		globalThis.fetch = (async () => {
			fetchCalls++;
			return handler(fetchCalls);
		}) as typeof globalThis.fetch;
	}

	test("正常応答からcontentを取得できること", async () => {
		stubFetch(() => okResponse("translated text"));
		const provider = new OpenAIProvider(createConfig(), FAST_POLICY);
		const result = await provider.sendMessage("system", [{ role: "user", content: "hello" }]);
		assert.strictEqual(result, "translated text");
		assert.strictEqual(fetchCalls, 1);
	});

	test("429応答はRetry-Afterに従ってリトライし回復すること", async () => {
		stubFetch((call) =>
			call === 1 ? errorResponse(429, { "retry-after": "0" }) : okResponse("recovered"),
		);
		const provider = new OpenAIProvider(createConfig(), FAST_POLICY);
		const result = await provider.sendMessage("system", [{ role: "user", content: "hello" }]);
		assert.strictEqual(result, "recovered");
		assert.strictEqual(fetchCalls, 2);
	});

	test("503応答はリトライし回復すること", async () => {
		stubFetch((call) => (call <= 2 ? errorResponse(503) : okResponse("recovered")));
		const provider = new OpenAIProvider(createConfig(), FAST_POLICY);
		const result = await provider.sendMessage("system", [{ role: "user", content: "hello" }]);
		assert.strictEqual(result, "recovered");
		assert.strictEqual(fetchCalls, 3);
	});

	test("401応答はリトライせず即失敗すること", async () => {
		stubFetch(() => errorResponse(401));
		const provider = new OpenAIProvider(createConfig(), FAST_POLICY);
		await assert.rejects(
			provider.sendMessage("system", [{ role: "user", content: "hello" }]),
			/OpenAI provider error/,
		);
		assert.strictEqual(fetchCalls, 1);
	});

	test("リトライ上限超過で失敗すること", async () => {
		stubFetch(() => errorResponse(500));
		const provider = new OpenAIProvider(createConfig(), FAST_POLICY);
		await assert.rejects(
			provider.sendMessage("system", [{ role: "user", content: "hello" }]),
			/OpenAI provider error/,
		);
		// 初回 + maxRetries(2) = 3試行
		assert.strictEqual(fetchCalls, 3);
	});

	test("ネットワークエラー（fetch reject）からリトライで回復すること", async () => {
		stubFetch((call) => {
			if (call === 1) {
				throw new TypeError("fetch failed");
			}
			return okResponse("recovered");
		});
		const provider = new OpenAIProvider(createConfig(), FAST_POLICY);
		const result = await provider.sendMessage("system", [{ role: "user", content: "hello" }]);
		assert.strictEqual(result, "recovered");
		assert.strictEqual(fetchCalls, 2);
	});

	test("キャンセル済みトークンでは即中断すること", async () => {
		stubFetch(() => okResponse("should not reach"));
		const provider = new OpenAIProvider(createConfig(), FAST_POLICY);
		const token = {
			isCancellationRequested: true,
			onCancellationRequested: () => ({ dispose() {} }),
		} as unknown as vscode.CancellationToken;
		await assert.rejects(
			provider.sendMessage("system", [{ role: "user", content: "hello" }], token),
			/cancelled/i,
		);
		assert.strictEqual(fetchCalls, 0);
	});

	test("APIキー未設定ではコンストラクタで失敗すること", () => {
		const config = createConfig();
		config.openai = {};
		const savedKey = process.env.OPENAI_API_KEY;
		// 空文字列はfalsyのためAPIキー未設定として扱われる
		process.env.OPENAI_API_KEY = "";
		try {
			assert.throws(() => new OpenAIProvider(config), /API key/);
		} finally {
			if (savedKey !== undefined) {
				process.env.OPENAI_API_KEY = savedKey;
			} else {
				Reflect.deleteProperty(process.env, "OPENAI_API_KEY");
			}
		}
	});
});
