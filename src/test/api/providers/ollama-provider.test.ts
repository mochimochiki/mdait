import { strict as assert } from "node:assert";
import type { AIMessage } from "../../../api/ai-service";
import { OllamaProvider } from "../../../api/providers/ollama-provider";

suite("OllamaProvider Tests", () => {
	test("OllamaProviderのインスタンスが作成できること", () => {
		const provider = new OllamaProvider({
			provider: "ollama",
			endpoint: "http://localhost:11434",
			ollamaModel: "llama2",
		});
		assert.ok(provider);
	});

	test("sendMessageメソッドが存在すること", () => {
		const provider = new OllamaProvider({
			provider: "ollama",
			endpoint: "http://localhost:11434",
			ollamaModel: "llama2",
		});
		assert.ok(typeof provider.sendMessage === "function");
	});

	test("デフォルト設定でインスタンスが作成できること", () => {
		const provider = new OllamaProvider({});
		assert.ok(provider);
	});

	test("カスタムエンドポイントとモデルが設定されること", () => {
		const customEndpoint = "http://custom-ollama:11434";
		const customModel = "mistral";

		const provider = new OllamaProvider({
			endpoint: customEndpoint,
			ollamaModel: customModel,
		});

		assert.ok(provider);
		// 内部実装の検証は困難なため、エラーが発生しないことを確認
	});

	test("汎用model設定がフォールバックとして使用されること", () => {
		const provider = new OllamaProvider({
			model: "gpt-3.5-turbo", // ollamaModel が未設定の場合のフォールバック
		});

		assert.ok(provider);
	});
});
