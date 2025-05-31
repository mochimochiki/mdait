import * as assert from "node:assert";
import type { AIMessage } from "../../../api/ai-service";
import { VSCodeLanguageModelProvider } from "../../../api/providers/vscode-lm-provider";

suite("VSCodeLanguageModelProvider Tests", () => {
	test("VSCodeLanguageModelProviderのインスタンスが作成できること", () => {
		const provider = new VSCodeLanguageModelProvider({ provider: "vscode-lm" });
		assert.ok(provider);
	});

	test("sendMessageメソッドが存在すること", () => {
		const provider = new VSCodeLanguageModelProvider({ provider: "vscode-lm" });
		assert.ok(typeof provider.sendMessage === "function");
	});

	// 注意: VS Code Language Model API を実際に呼び出すテストは、
	// テスト環境では GitHub Copilot が利用できない可能性があるため、
	// 統合テストとして別途実装することを推奨
});
