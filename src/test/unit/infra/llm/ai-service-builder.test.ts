import * as assert from "node:assert";
import {
	type AIConfig,
	Configuration,
} from "../../../../infra/config/configuration";
import { AIServiceBuilder } from "../../../../infra/llm/ai-service-builder";
import { DefaultAIProvider } from "../../../../infra/llm/providers/default-ai-provider";
import { VSCodeLanguageModelProvider } from "../../../../infra/llm/providers/vscode-lm-provider";

function createConfig(provider: AIConfig["provider"]): AIConfig {
	return {
		provider,
		model: "test-model",
		ollama: { endpoint: "http://localhost:11434", model: "llama2" },
	};
}

suite("AIServiceBuilder", () => {
	setup(() => {
		Configuration.dispose();
	});

	teardown(() => {
		Configuration.dispose();
	});

	test("defaultは外部LLMを呼ばないモックプロバイダーを生成すること", async () => {
		const service = await new AIServiceBuilder().build(createConfig("default"));

		assert.ok(service instanceof DefaultAIProvider);
		assert.ok(!(service instanceof VSCodeLanguageModelProvider));
	});

	test("vscode-lmはVS Code Language Modelプロバイダーを生成すること", async () => {
		const service = await new AIServiceBuilder().build(
			createConfig("vscode-lm"),
		);

		assert.ok(service instanceof VSCodeLanguageModelProvider);
		assert.ok(!(service instanceof DefaultAIProvider));
	});

	test("設定未指定時の既定値はvscode-lmであること", async () => {
		const service = await new AIServiceBuilder().build();

		assert.strictEqual(Configuration.getInstance().ai.provider, "vscode-lm");
		assert.ok(service instanceof VSCodeLanguageModelProvider);
	});
});
