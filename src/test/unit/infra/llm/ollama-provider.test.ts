import * as assert from "node:assert";
import type { Ollama } from "ollama";
import type { AIConfig } from "../../../../infra/config/configuration";
import { Configuration } from "../../../../infra/config/configuration";
import { OllamaProvider } from "../../../../infra/llm/providers/ollama-provider";

/** テスト用AIConfig（タイムアウトは50ms） */
function createConfig(): AIConfig {
	return {
		provider: "ollama",
		model: "test-model",
		ollama: { endpoint: "http://localhost:11434", model: "test-model", timeoutSec: 0.05 },
	};
}

/** 解決しないPromise */
function never<T>(): Promise<T> {
	return new Promise<T>(() => {});
}

/** チャンク列を返すフェイクのAbortableAsyncIterator風オブジェクトを作成 */
function createFakeStream(
	chunks: Array<{ response: string; done: boolean }>,
	options?: { stallAfter?: number },
) {
	let aborted = false;
	let index = 0;
	const stream = {
		abort() {
			aborted = true;
		},
		[Symbol.asyncIterator]() {
			return {
				async next() {
					if (options?.stallAfter !== undefined && index >= options.stallAfter) {
						return never<IteratorResult<{ response: string; done: boolean }>>();
					}
					if (index >= chunks.length) {
						return { done: true as const, value: undefined };
					}
					return { done: false as const, value: chunks[index++] };
				},
			};
		},
	};
	return { stream, wasAborted: () => aborted };
}

/** フェイクOllamaクライアントを作成 */
function createFakeClient(generateImpl: () => Promise<unknown>) {
	let clientAborted = false;
	const client = {
		generate: generateImpl,
		abort() {
			clientAborted = true;
		},
	} as unknown as Pick<Ollama, "generate" | "abort">;
	return { client, wasClientAborted: () => clientAborted };
}

suite("OllamaProvider", () => {
	setup(() => {
		// 統計ログのファイル書き込みを抑止
		Configuration.dispose();
		const config = Configuration.getInstance();
		config.ai.debug = { enableStatsLogging: false, logPromptAndResponse: false };
	});

	teardown(() => {
		Configuration.dispose();
	});

	test("ストリーミングチャンクを結合して応答を返すこと", async () => {
		const { stream } = createFakeStream([
			{ response: "Hello ", done: false },
			{ response: "world", done: true },
		]);
		const { client } = createFakeClient(async () => stream);
		const provider = new OllamaProvider(createConfig(), client);

		const result = await provider.sendMessage("system", [{ role: "user", content: "hi" }]);
		assert.strictEqual(result, "Hello world");
	});

	test("初回応答がない場合はタイムアウトしクライアントをabortすること", async () => {
		const { client, wasClientAborted } = createFakeClient(() => never());
		const provider = new OllamaProvider(createConfig(), client);

		await assert.rejects(
			provider.sendMessage("system", [{ role: "user", content: "hi" }]),
			/timed out/,
		);
		assert.strictEqual(wasClientAborted(), true);
	});

	test("チャンク間でストリームが停止した場合はタイムアウトしストリームをabortすること", async () => {
		const { stream, wasAborted } = createFakeStream(
			[
				{ response: "partial ", done: false },
				{ response: "never delivered", done: true },
			],
			{ stallAfter: 1 },
		);
		const { client } = createFakeClient(async () => stream);
		const provider = new OllamaProvider(createConfig(), client);

		await assert.rejects(
			provider.sendMessage("system", [{ role: "user", content: "hi" }]),
			/timed out/,
		);
		assert.strictEqual(wasAborted(), true);
	});

	test("timeoutSec未指定時もデフォルトで動作すること", async () => {
		const config = createConfig();
		config.ollama = { endpoint: "http://localhost:11434", model: "test-model" };
		const { stream } = createFakeStream([{ response: "ok", done: true }]);
		const { client } = createFakeClient(async () => stream);
		const provider = new OllamaProvider(config, client);

		const result = await provider.sendMessage("", [{ role: "user", content: "hi" }]);
		assert.strictEqual(result, "ok");
	});
});
