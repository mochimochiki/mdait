/**
 * @file translator-user-message.test.ts
 * @description AITranslatorのメッセージ構成テスト
 * 可変コンテキストがuser message側に入り、system promptがリトライ時も
 * 不変であること（プレフィックスキャッシュの前提）を検証する
 */

import { strict as assert } from "node:assert";
import { TranslationContext } from "../../../../commands/trans/translation-context";
import { AITranslator } from "../../../../commands/trans/translator";
import type { AIMessage, AIService } from "../../../../infra/llm/ai-service";
import { SOURCE_TEXT_SEPARATOR } from "../../../../prompts/defaults";
import type { PromptParts } from "../../../../prompts/prompt-provider";

/** 呼び出しごとのsystemPromptとmessagesを記録するモックAIサービス */
class CapturingMockAIService implements AIService {
	readonly calls: Array<{ systemPrompt: string; messages: AIMessage[] }> = [];
	private responses: string[];

	constructor(responses: string[]) {
		this.responses = responses;
	}

	async sendMessage(systemPrompt: string, messages: AIMessage[]): Promise<string> {
		this.calls.push({ systemPrompt, messages });
		return this.responses[this.calls.length - 1] ?? this.responses[this.responses.length - 1];
	}
}

const STATIC_SYSTEM = "STATIC-SYSTEM-PROMPT";

function createParts(userContext: string): PromptParts {
	return { system: STATIC_SYSTEM, userContext, isLegacy: false };
}

suite("AITranslator メッセージ構成", () => {
	test("可変コンテキストはuser message側に入りsystemには含まれない", async () => {
		const mockService = new CapturingMockAIService(['{"translation": "ok", "termSuggestions": []}']);
		const translator = new AITranslator(mockService, "en", () => createParts("VARIABLE-CONTEXT"));

		await translator.translate("Hello", "en", "ja", new TranslationContext());

		const call = mockService.calls[0];
		assert.strictEqual(call.systemPrompt, STATIC_SYSTEM);
		const userContent = call.messages[0].content as string;
		assert.ok(userContent.includes("VARIABLE-CONTEXT"));
		assert.ok(userContent.includes(SOURCE_TEXT_SEPARATOR));
		assert.ok(userContent.includes("Hello"));
	});

	test("リトライ時の補足はuser message側に付与されsystemは不変", async () => {
		const mockService = new CapturingMockAIService([
			"これはJSONではありません", // 1回目: 失敗
			'{"translation": "ok", "termSuggestions": []}', // 2回目: 成功
		]);
		const translator = new AITranslator(mockService, "en", () => createParts("CTX"));

		await translator.translate("Hello", "en", "ja", new TranslationContext());

		assert.strictEqual(mockService.calls.length, 2);
		// system promptは全試行で完全一致（プレフィックスキャッシュ維持）
		assert.strictEqual(mockService.calls[0].systemPrompt, STATIC_SYSTEM);
		assert.strictEqual(mockService.calls[1].systemPrompt, STATIC_SYSTEM);
		// リトライ補足はuser messageの末尾に付く
		const retryContent = mockService.calls[1].messages[0].content as string;
		assert.ok(retryContent.includes("RETRY INSTRUCTION"));
		const firstContent = mockService.calls[0].messages[0].content as string;
		assert.ok(!firstContent.includes("RETRY INSTRUCTION"));
	});

	test("改訂パッチでもリトライ時にsystemが不変", async () => {
		const mockService = new CapturingMockAIService([
			"無効な応答",
			'{"targetPatch": "=ctx\\n-old\\n+new", "termSuggestions": []}',
		]);
		const translator = new AITranslator(mockService, "en", () => createParts("CTX"));

		const context = new TranslationContext();
		context.previousTranslation = "前回の翻訳";
		context.sourceDiff = "-old\n+new";
		await translator.translateRevisionPatch("Hello", "en", "ja", context);

		assert.strictEqual(mockService.calls.length, 2);
		assert.strictEqual(mockService.calls[0].systemPrompt, STATIC_SYSTEM);
		assert.strictEqual(mockService.calls[1].systemPrompt, STATIC_SYSTEM);
		const retryContent = mockService.calls[1].messages[0].content as string;
		assert.ok(retryContent.includes("RETRY INSTRUCTION"));
	});

	test("レガシーテンプレートでは本文のみがuser messageになる（従来挙動）", async () => {
		const mockService = new CapturingMockAIService(['{"translation": "ok", "termSuggestions": []}']);
		const translator = new AITranslator(mockService, "en", () => ({
			system: "legacy-full-prompt",
			userContext: "",
			isLegacy: true,
		}));

		await translator.translate("Hello", "en", "ja", new TranslationContext());

		const call = mockService.calls[0];
		assert.strictEqual(call.systemPrompt, "legacy-full-prompt");
		assert.strictEqual(call.messages[0].content, "Hello");
	});
});
