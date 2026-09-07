import * as assert from "node:assert";
import {
	type AIConfig,
	Configuration,
} from "../../../../infra/config/configuration";
import { AIServiceBuilder } from "../../../../infra/llm/ai-service-builder";
import { hasAiCallGuard, unwrapAiCallGuard } from "../../../../infra/llm/call-budget";
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
		const provider = unwrapAiCallGuard(await new AIServiceBuilder().build(createConfig("default")));

		assert.ok(provider instanceof DefaultAIProvider);
		assert.ok(!(provider instanceof VSCodeLanguageModelProvider));
	});

	test("vscode-lmはVS Code Language Modelプロバイダーを生成すること", async () => {
		const provider = unwrapAiCallGuard(await new AIServiceBuilder().build(createConfig("vscode-lm")));

		assert.ok(provider instanceof VSCodeLanguageModelProvider);
		assert.ok(!(provider instanceof DefaultAIProvider));
	});

	test("設定未指定時の既定値はvscode-lmであること", async () => {
		const service = await new AIServiceBuilder().build();

		assert.strictEqual(Configuration.getInstance().ai.provider, "vscode-lm");
		assert.ok(unwrapAiCallGuard(service) instanceof VSCodeLanguageModelProvider);
	});

	test("どのプロバイダでも、返るのは歯止め付きのAIServiceであること", async () => {
		// 呼び過ぎの歯止めはここ1か所にしかない。素のプロバイダをそのまま返す道ができると、
		// その経路だけ誰も見ていない状態に戻る
		for (const provider of ["default", "vscode-lm", "ollama"] as const) {
			const service = await new AIServiceBuilder().build(createConfig(provider));
			assert.ok(hasAiCallGuard(service), `${provider} に歯止めが付いていること`);
		}
	});
});
