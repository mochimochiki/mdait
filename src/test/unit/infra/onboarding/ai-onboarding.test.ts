import * as assert from "node:assert";
import type { AIConfig } from "../../../../infra/config/configuration";
import { describeAiService } from "../../../../infra/onboarding/ai-onboarding";

function createConfig(overrides: Partial<AIConfig> = {}): AIConfig {
	return {
		provider: "vscode-lm",
		vendor: "copilot",
		model: "gpt-4o",
		ollama: { endpoint: "http://localhost:11434", model: "llama2" },
		...overrides,
	};
}

suite("describeAiService", () => {
	test("vscode-lmはprovider・vendor・modelを「 / 」区切りで表示すること", () => {
		const label = describeAiService(createConfig({ provider: "vscode-lm", vendor: "customendpoint", model: "gemma-4-E4B" }));
		assert.strictEqual(label, "vscode-lm / customendpoint / gemma-4-E4B");
	});

	test("vscode-lmでvendor未指定時は既定のcopilotを表示すること", () => {
		const label = describeAiService(createConfig({ vendor: undefined }));
		assert.strictEqual(label, "vscode-lm / copilot / gpt-4o");
	});

	test("ollamaはollama.modelを優先して表示すること", () => {
		const label = describeAiService(createConfig({ provider: "ollama", model: "gpt-4o" }));
		assert.strictEqual(label, "ollama / llama2");
	});

	test("ollamaでモデル未指定時は既定のllama2を表示すること", () => {
		const label = describeAiService(
			createConfig({ provider: "ollama", model: "", ollama: { endpoint: "http://localhost:11434", model: "" } }),
		);
		assert.strictEqual(label, "ollama / llama2");
	});

	test("openaiはmodelを表示し、未指定時は既定のgpt-5-miniを表示すること", () => {
		assert.strictEqual(describeAiService(createConfig({ provider: "openai", model: "gpt-4o" })), "openai / gpt-4o");
		assert.strictEqual(describeAiService(createConfig({ provider: "openai", model: "" })), "openai / gpt-5-mini");
	});

	test("未知のproviderでもproviderとmodelを表示すること", () => {
		const label = describeAiService(createConfig({ provider: "anthropic", model: "claude" }));
		assert.strictEqual(label, "anthropic / claude");
	});
});
