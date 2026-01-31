/**
 * @file translator-retry.test.ts
 * @description DefaultTranslatorのリトライ機構テスト実装
 * バリデーション失敗時のリトライとフォールバック処理の検証
 */

import { strict as assert } from "node:assert";
import type * as vscode from "vscode";
import type { AIMessage, AIService } from "../../../api/ai-service";
import type { TranslationContext } from "../../../commands/trans/translation-context";
import { AITranslator, type RevisionPatchResult, type TranslationResult } from "../../../commands/trans/translator";
import { Configuration } from "../../../config/configuration";
import { PromptProvider } from "../../../prompts";

/**
 * モックAIサービス
 * 呼び出し回数に応じて異なるレスポンスを返す
 */
class MockAIService implements AIService {
	private callCount = 0;
	private responses: string[];

	constructor(responses: string[]) {
		this.responses = responses;
	}

	async sendMessage(_systemPrompt: string, _messages: AIMessage[]): Promise<string> {
		const response = this.responses[this.callCount] ?? this.responses[this.responses.length - 1];
		this.callCount++;
		return response;
	}

	getCallCount(): number {
		return this.callCount;
	}

	getLastSystemPrompt(): string {
		return ""; // このテストでは使用しない
	}
}

suite("DefaultTranslator リトライ機構", () => {
	const defaultContext: TranslationContext = {
		surroundingText: "",
		terms: "",
		previousTranslation: undefined,
		sourceDiff: undefined,
	};

	suiteSetup(() => {
		// Configuration と PromptProvider の初期化
		// テスト用のモックワークスペースを設定
		const mockWorkspaceFolder = {
			uri: { fsPath: "/mock/workspace" },
			name: "mock",
			index: 0,
		};
		Configuration.initialize([mockWorkspaceFolder as unknown as vscode.WorkspaceFolder]);
		PromptProvider.initialize();
	});

	suite("translate", () => {
		test("正常なレスポンスは1回で成功する", async () => {
			const mockService = new MockAIService(['{"translation": "翻訳されたテキスト", "termSuggestions": []}']);
			const translator = new AITranslator(mockService);

			const result = await translator.translate("Hello", "en", "ja", defaultContext);

			assert.strictEqual(result.translatedText, "翻訳されたテキスト");
			assert.strictEqual(mockService.getCallCount(), 1);
			assert.strictEqual(result.warnings?.length ?? 0, 0);
		});

		test("1回目失敗→2回目成功でリトライが機能する", async () => {
			const mockService = new MockAIService([
				"これはJSONではありません", // 1回目: パースエラー
				'{"translation": "リトライ後の翻訳", "termSuggestions": []}', // 2回目: 成功
			]);
			const translator = new AITranslator(mockService);

			const result = await translator.translate("Hello", "en", "ja", defaultContext);

			assert.strictEqual(result.translatedText, "リトライ後の翻訳");
			assert.strictEqual(mockService.getCallCount(), 2);
		});

		test("2回失敗→3回目成功でリトライが機能する", async () => {
			const mockService = new MockAIService([
				"JSONではない1", // 1回目: パースエラー
				"JSONではない2", // 2回目: パースエラー
				'{"translation": "3回目で成功", "termSuggestions": []}', // 3回目: 成功
			]);
			const translator = new AITranslator(mockService);

			const result = await translator.translate("Hello", "en", "ja", defaultContext);

			assert.strictEqual(result.translatedText, "3回目で成功");
			assert.strictEqual(mockService.getCallCount(), 3);
		});

		test("3回すべて失敗でフォールバックが機能する", async () => {
			const mockService = new MockAIService([
				"フォールバックテキスト1",
				"フォールバックテキスト2",
				"フォールバックテキスト3",
			]);
			const translator = new AITranslator(mockService);

			const result = await translator.translate("Hello", "en", "ja", defaultContext);

			// フォールバック時は最後の生レスポンスを使用
			assert.strictEqual(result.translatedText, "フォールバックテキスト3");
			assert.strictEqual(mockService.getCallCount(), 3);
			assert.ok(result.warnings?.some((w) => w.includes("unexpected")));
		});

		test("translation フィールド欠落でリトライする", async () => {
			const mockService = new MockAIService([
				'{"text": "間違ったフィールド名"}', // 1回目: フィールド欠落
				'{"translation": "正しいフィールド名", "termSuggestions": []}', // 2回目: 成功
			]);
			const translator = new AITranslator(mockService);

			const result = await translator.translate("Hello", "en", "ja", defaultContext);

			assert.strictEqual(result.translatedText, "正しいフィールド名");
			assert.strictEqual(mockService.getCallCount(), 2);
		});

		test("JSON混入検出でリトライする", async () => {
			const mockService = new MockAIService([
				// 1回目: translation内にJSON混入
				'{"translation": "{\\"translation\\": \\"ネストされた\\"}"}',
				// 2回目: 正常
				'{"translation": "正常な翻訳", "termSuggestions": []}',
			]);
			const translator = new AITranslator(mockService);

			const result = await translator.translate("Hello", "en", "ja", defaultContext);

			assert.strictEqual(result.translatedText, "正常な翻訳");
			assert.strictEqual(mockService.getCallCount(), 2);
		});

		test("コードブロックプレースホルダーが復元される", async () => {
			const mockService = new MockAIService([
				'{"translation": "翻訳 __CODE_BLOCK_PLACEHOLDER_0__ 続き", "termSuggestions": []}',
			]);
			const translator = new AITranslator(mockService);

			const result = await translator.translate("Text ```code``` more", "en", "ja", defaultContext);

			assert.ok(result.translatedText.includes("```code```"));
			assert.ok(!result.translatedText.includes("__CODE_BLOCK_PLACEHOLDER_"));
		});

		test("termSuggestionsが正しく返される", async () => {
			const mockService = new MockAIService([
				JSON.stringify({
					translation: "翻訳されたテキスト",
					termSuggestions: [{ source: "test", target: "テスト", context: "this is a test" }],
				}),
			]);
			const translator = new AITranslator(mockService);

			const result = await translator.translate("Hello", "en", "ja", defaultContext);

			assert.strictEqual(result.termSuggestions?.length, 1);
			assert.strictEqual(result.termSuggestions?.[0].source, "test");
		});
	});

	suite("translateRevisionPatch", () => {
		const contextWithPrevious: TranslationContext = {
			surroundingText: "",
			terms: "",
			previousTranslation: "前回の翻訳",
			sourceDiff: "--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new",
		};

		test("正常なレスポンスは1回で成功する", async () => {
			const mockService = new MockAIService([
				'{"targetPatch": "--- content\\n+++ content\\n@@ -1 +1 @@\\n-old\\n+new", "termSuggestions": []}',
			]);
			const translator = new AITranslator(mockService);

			const result = await translator.translateRevisionPatch("Hello", "en", "ja", contextWithPrevious);

			assert.ok(result.targetPatch.includes("--- content"));
			assert.strictEqual(mockService.getCallCount(), 1);
		});

		test("1回目失敗→2回目成功でリトライが機能する", async () => {
			const mockService = new MockAIService([
				"これはJSONではありません",
				'{"targetPatch": "--- content\\n+++ content", "termSuggestions": []}',
			]);
			const translator = new AITranslator(mockService);

			const result = await translator.translateRevisionPatch("Hello", "en", "ja", contextWithPrevious);

			assert.ok(result.targetPatch.includes("--- content"));
			assert.strictEqual(mockService.getCallCount(), 2);
		});

		test("targetPatch フィールド欠落でリトライする", async () => {
			const mockService = new MockAIService([
				'{"patch": "間違ったフィールド名"}',
				'{"targetPatch": "正しいパッチ", "termSuggestions": []}',
			]);
			const translator = new AITranslator(mockService);

			const result = await translator.translateRevisionPatch("Hello", "en", "ja", contextWithPrevious);

			assert.strictEqual(result.targetPatch, "正しいパッチ");
			assert.strictEqual(mockService.getCallCount(), 2);
		});

		test("3回すべて失敗でフォールバックが機能する", async () => {
			const mockService = new MockAIService(["フォールバック1", "フォールバック2", "フォールバック3"]);
			const translator = new AITranslator(mockService);

			const result = await translator.translateRevisionPatch("Hello", "en", "ja", contextWithPrevious);

			assert.strictEqual(result.targetPatch, "フォールバック3");
			assert.ok(result.warnings?.some((w) => w.includes("unexpected")));
		});

		test("warningsが正しく結合される", async () => {
			const mockService = new MockAIService([
				JSON.stringify({
					targetPatch: "パッチ",
					warnings: ["AIからの警告"],
				}),
			]);
			const translator = new AITranslator(mockService);

			const result = await translator.translateRevisionPatch("Hello", "en", "ja", contextWithPrevious);

			assert.ok(result.warnings?.includes("AIからの警告"));
		});
	});
});
