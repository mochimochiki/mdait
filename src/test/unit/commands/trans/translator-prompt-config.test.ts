/**
 * @file translator-prompt-config.test.ts
 * @description AITranslatorのプロンプト設定切り替えテスト
 * MD用/非MD用のプロンプトIDが正しく選択されることを検証
 */

import { strict as assert } from "node:assert";
import { TranslationContext } from "../../../../commands/trans/translation-context";
import { AITranslator, PLAIN_PROMPT_CONFIG } from "../../../../commands/trans/translator";
import type { AIMessage, AIService } from "../../../../infra/llm/ai-service";
import { PromptIds } from "../../../../prompts/defaults";
import type { PromptId } from "../../../../prompts/defaults";

/**
 * プロンプトID記録用モックAIサービス
 */
class PromptCapturingMockAIService implements AIService {
	lastSystemPrompt = "";

	async sendMessage(systemPrompt: string, _messages: AIMessage[]): Promise<string> {
		this.lastSystemPrompt = systemPrompt;
		return '{"translation": "translated", "termSuggestions": []}';
	}
}

suite("AITranslator プロンプト設定", () => {
	test("デフォルトではMD用のプロンプトIDが使用される", async () => {
		const mockService = new PromptCapturingMockAIService();
		let capturedPromptId: PromptId | undefined;

		const translator = new AITranslator(mockService, "en", (id, _vars) => {
			capturedPromptId = id;
			return { system: "stub-prompt", userContext: "", isLegacy: true };
		});

		await translator.translate("Hello", "en", "ja", new TranslationContext());
		assert.strictEqual(capturedPromptId, PromptIds.TRANS_TRANSLATE);
	});

	test("PLAIN_PROMPT_CONFIG指定で非MD用の翻訳プロンプトIDが使用される", async () => {
		const mockService = new PromptCapturingMockAIService();
		let capturedPromptId: PromptId | undefined;

		const translator = new AITranslator(
			mockService,
			"en",
			(id, _vars) => {
				capturedPromptId = id;
				return { system: "stub-prompt", userContext: "", isLegacy: true };
			},
			PLAIN_PROMPT_CONFIG,
		);

		await translator.translate("Hello", "en", "ja", new TranslationContext());
		assert.strictEqual(capturedPromptId, PromptIds.TRANS_TRANSLATE_PLAIN);
	});

	test("PLAIN_PROMPT_CONFIG指定で非MD用の改訂プロンプトIDが使用される", async () => {
		const mockService = new PromptCapturingMockAIService();
		let capturedPromptId: PromptId | undefined;

		// translateRevisionPatchのレスポンス用に調整
		mockService.sendMessage = async (systemPrompt, _msgs) => {
			mockService.lastSystemPrompt = systemPrompt;
			return "REPLACE 1\npatch\nEND";
		};

		const translator = new AITranslator(
			mockService,
			"en",
			(id, _vars) => {
				capturedPromptId = id;
				return { system: "stub-prompt", userContext: "", isLegacy: true };
			},
			PLAIN_PROMPT_CONFIG,
		);

		const context = new TranslationContext();
		context.previousTranslation = "前回の翻訳";
		context.sourceDiff = "--- a\n+++ b";

		await translator.translateRevisionPatch("Hello", "en", "ja", context);
		assert.strictEqual(capturedPromptId, PromptIds.TRANS_REVISE_PATCH_PLAIN);
	});

	test("fileExtension変数がプロンプトに渡される", async () => {
		const mockService = new PromptCapturingMockAIService();
		let capturedVars: Record<string, string | undefined> | undefined;

		const translator = new AITranslator(
			mockService,
			"en",
			(id, vars) => {
				capturedVars = vars;
				return { system: "stub-prompt", userContext: "", isLegacy: true };
			},
			PLAIN_PROMPT_CONFIG,
		);

		const context = new TranslationContext();
		context.fileExtension = ".csv";

		await translator.translate("data", "en", "ja", context);
		assert.strictEqual(capturedVars?.fileExtension, ".csv");
	});

	test("fileExtension未設定時はundefinedが渡される", async () => {
		const mockService = new PromptCapturingMockAIService();
		let capturedVars: Record<string, string | undefined> | undefined;

		const translator = new AITranslator(mockService, "en", (id, vars) => {
			capturedVars = vars;
			return { system: "stub-prompt", userContext: "", isLegacy: true };
		});

		await translator.translate("data", "en", "ja", new TranslationContext());
		assert.strictEqual(capturedVars?.fileExtension, undefined);
	});
});
