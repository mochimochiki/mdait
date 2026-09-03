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

/** chat APIのストリーミングチャンク型（テストで使用する最小構成） */
interface FakeChatChunk {
	message: { content: string };
	done: boolean;
	prompt_eval_count?: number;
	eval_count?: number;
}

/** チャンク列を返すフェイクのAbortableAsyncIterator風オブジェクトを作成 */
function createFakeStream(
	chunks: FakeChatChunk[],
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
						return never<IteratorResult<FakeChatChunk>>();
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
function createFakeClient(chatImpl: (request?: unknown) => Promise<unknown>) {
	let clientAborted = false;
	const requests: unknown[] = [];
	const client = {
		chat(request: unknown) {
			requests.push(request);
			return chatImpl(request);
		},
		abort() {
			clientAborted = true;
		},
	} as unknown as Pick<Ollama, "chat" | "abort">;
	return {
		client,
		wasClientAborted: () => clientAborted,
		getRequests: () => requests,
	};
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
			{ message: { content: "Hello " }, done: false },
			{ message: { content: "world" }, done: true },
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
				{ message: { content: "partial " }, done: false },
				{ message: { content: "never delivered" }, done: true },
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
		const { stream } = createFakeStream([{ message: { content: "ok" }, done: true }]);
		const { client } = createFakeClient(async () => stream);
		const provider = new OllamaProvider(config, client);

		const result = await provider.sendMessage("", [{ role: "user", content: "hi" }]);
		assert.strictEqual(result, "ok");
	});

	test("systemプロンプトがsystemロールとして分離して送信されること", async () => {
		const { stream } = createFakeStream([{ message: { content: "ok" }, done: true }]);
		const { client, getRequests } = createFakeClient(async () => stream);
		const provider = new OllamaProvider(createConfig(), client);

		await provider.sendMessage("system instructions", [{ role: "user", content: "hi" }]);

		const request = getRequests()[0] as { messages: Array<{ role: string; content: string }> };
		assert.strictEqual(request.messages.length, 2);
		assert.strictEqual(request.messages[0].role, "system");
		assert.strictEqual(request.messages[0].content, "system instructions");
		assert.strictEqual(request.messages[1].role, "user");
		assert.strictEqual(request.messages[1].content, "hi");
	});

	test("keepAlive設定時はkeep_aliveがリクエストに含まれること", async () => {
		const config = createConfig();
		config.ollama = { endpoint: "http://localhost:11434", model: "test-model", keepAlive: "10m" };
		const { stream } = createFakeStream([{ message: { content: "ok" }, done: true }]);
		const { client, getRequests } = createFakeClient(async () => stream);
		const provider = new OllamaProvider(config, client);

		await provider.sendMessage("system", [{ role: "user", content: "hi" }]);

		const request = getRequests()[0] as { keep_alive?: string | number };
		assert.strictEqual(request.keep_alive, "10m");
	});

	test("keepAlive未設定時はkeep_aliveがリクエストに含まれないこと", async () => {
		const { stream } = createFakeStream([{ message: { content: "ok" }, done: true }]);
		const { client, getRequests } = createFakeClient(async () => stream);
		const provider = new OllamaProvider(createConfig(), client);

		await provider.sendMessage("system", [{ role: "user", content: "hi" }]);

		const request = getRequests()[0] as Record<string, unknown>;
		assert.strictEqual("keep_alive" in request, false);
	});
});
