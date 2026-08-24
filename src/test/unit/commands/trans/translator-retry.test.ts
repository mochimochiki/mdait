/**
 * @file translator-retry.test.ts
 * @description DefaultTranslatorのリトライ機構テスト実装
 *
 * バリデーション失敗時の送り直しと、**送り直しても直らなかったときの後始末**の検証。
 *
 * 後始末の約束は途中で変わっている。以前は「最後の生応答をそのまま訳文として返す」
 * フォールバックだったが、それにより途中で切れた JSON や空文字がそのまま本文になり、
 * need フラグまで外れて「翻訳できた」と報告されていた。いまは**失敗として投げる**
 * （UnusableAIResponseError）。訳文を書かないことは呼び出し側の責任として、
 * ここでは「使えない答えを訳文として返さない」ことだけを固定する。
 */

import { strict as assert } from "node:assert";
import { TranslationContext } from "../../../../commands/trans/translation-context";
import { AITranslator, type RevisionPatchResult, type TranslationResult } from "../../../../commands/trans/translator";
import type { AIMessage, AIService } from "../../../../infra/llm/ai-service";
import { UnusableAIResponseError } from "../../../../infra/llm/unusable-response";

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
	const defaultContext = new TranslationContext();
	const stubGetPromptParts = (_id: string, _vars?: Record<string, string | undefined>) => ({
		system: "stub-prompt",
		userContext: "",
		isLegacy: true,
	});
	const createTranslator = (service: AIService) => new AITranslator(service, "en", stubGetPromptParts);

	suite("translate", () => {
		test("正常なレスポンスは1回で成功する", async () => {
			const mockService = new MockAIService(['{"translation": "翻訳されたテキスト", "termSuggestions": []}']);
			const translator = createTranslator(mockService);

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
			const translator = createTranslator(mockService);

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
			const translator = createTranslator(mockService);

			const result = await translator.translate("Hello", "en", "ja", defaultContext);

			assert.strictEqual(result.translatedText, "3回目で成功");
			assert.strictEqual(mockService.getCallCount(), 3);
		});

		test("3回すべて失敗したら、生応答を訳文にせず失敗として投げること", async () => {
			// 旧仕様ではここで「フォールバックテキスト3」がそのまま訳文になっていた。
			// 生応答が訳文へ回る道は残っていないことを固定する
			const mockService = new MockAIService([
				"フォールバックテキスト1",
				"フォールバックテキスト2",
				"フォールバックテキスト3",
			]);
			const translator = createTranslator(mockService);

			const error = await translator
				.translate("Hello", "en", "ja", defaultContext)
				.then(
					() => undefined,
					(e: unknown) => e,
				);

			assert.ok(error instanceof UnusableAIResponseError, "使えない答えとして投げること");
			assert.strictEqual(error.reason, "invalid-format");
			// 例外は「訳文の代わり」を持たない。JSON パーサのメッセージに生応答の断片が
			// 混じることはあるが、それは記録用であって本文へ回る道ではない
			assert.strictEqual(
				(error as unknown as { translatedText?: string }).translatedText,
				undefined,
				"訳文として使える値を持たないこと",
			);
			assert.strictEqual(mockService.getCallCount(), 3);
		});

		test("空の応答は「空」として失敗すること（形が違うとは言わない）", async () => {
			const mockService = new MockAIService(["", "", ""]);
			const translator = createTranslator(mockService);

			const error = await translator
				.translate("Hello", "en", "ja", defaultContext)
				.then(
					() => undefined,
					(e: unknown) => e,
				);

			assert.ok(error instanceof UnusableAIResponseError);
			assert.strictEqual(error.reason, "empty");
		});

		test("translation フィールド欠落でリトライする", async () => {
			const mockService = new MockAIService([
				'{"text": "間違ったフィールド名"}', // 1回目: フィールド欠落
				'{"translation": "正しいフィールド名", "termSuggestions": []}', // 2回目: 成功
			]);
			const translator = createTranslator(mockService);

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
			const translator = createTranslator(mockService);

			const result = await translator.translate("Hello", "en", "ja", defaultContext);

			assert.strictEqual(result.translatedText, "正常な翻訳");
			assert.strictEqual(mockService.getCallCount(), 2);
		});

		test("コードブロックプレースホルダーが復元される", async () => {
			const mockService = new MockAIService([
				'{"translation": "翻訳 __CODE_BLOCK_PLACEHOLDER_0__ 続き", "termSuggestions": []}',
			]);
			const translator = createTranslator(mockService);

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
			const translator = createTranslator(mockService);

			const result = await translator.translate("Hello", "en", "ja", defaultContext);

			assert.strictEqual(result.termSuggestions?.length, 1);
			assert.strictEqual(result.termSuggestions?.[0].source, "test");
		});
	});

	suite("translateRevisionPatch", () => {
		const contextWithPrevious = new TranslationContext();

		setup(() => {
			contextWithPrevious.previousTranslation = "前回の翻訳";
			contextWithPrevious.sourceDiff = "--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new";
		});

		test("正常なレスポンスは1回で成功する", async () => {
			const mockService = new MockAIService([
				'{"targetPatch": "--- content\\n+++ content\\n@@ -1 +1 @@\\n-old\\n+new", "termSuggestions": []}',
			]);
			const translator = createTranslator(mockService);

			const result = await translator.translateRevisionPatch("Hello", "en", "ja", contextWithPrevious);

			assert.ok(result.targetPatch.includes("--- content"));
			assert.strictEqual(mockService.getCallCount(), 1);
		});

		test("1回目失敗→2回目成功でリトライが機能する", async () => {
			const mockService = new MockAIService([
				"これはJSONではありません",
				'{"targetPatch": "--- content\\n+++ content", "termSuggestions": []}',
			]);
			const translator = createTranslator(mockService);

			const result = await translator.translateRevisionPatch("Hello", "en", "ja", contextWithPrevious);

			assert.ok(result.targetPatch.includes("--- content"));
			assert.strictEqual(mockService.getCallCount(), 2);
		});

		test("targetPatch フィールド欠落でリトライする", async () => {
			const mockService = new MockAIService([
				'{"patch": "間違ったフィールド名"}',
				'{"targetPatch": "正しいパッチ", "termSuggestions": []}',
			]);
			const translator = createTranslator(mockService);

			const result = await translator.translateRevisionPatch("Hello", "en", "ja", contextWithPrevious);

			assert.strictEqual(result.targetPatch, "正しいパッチ");
			assert.strictEqual(mockService.getCallCount(), 2);
		});

		test("3回すべて失敗したら、生応答をパッチにせず失敗として投げること", async () => {
			// 旧仕様ではここで「フォールバック3」がパッチとして扱われ、
			// 当てはめに失敗した理由が「差分の書き方が違う」にすり替わっていた
			const mockService = new MockAIService(["フォールバック1", "フォールバック2", "フォールバック3"]);
			const translator = createTranslator(mockService);

			const error = await translator
				.translateRevisionPatch("Hello", "en", "ja", contextWithPrevious)
				.then(
					() => undefined,
					(e: unknown) => e,
				);

			assert.ok(error instanceof UnusableAIResponseError, "使えない答えとして投げること");
			assert.strictEqual(error.reason, "invalid-format");
			assert.strictEqual(mockService.getCallCount(), 3);
		});

		test("warningsが正しく結合される", async () => {
			const mockService = new MockAIService([
				JSON.stringify({
					targetPatch: "パッチ",
					warnings: ["AIからの警告"],
				}),
			]);
			const translator = createTranslator(mockService);

			const result = await translator.translateRevisionPatch("Hello", "en", "ja", contextWithPrevious);

			assert.ok(result.warnings?.includes("AIからの警告"));
		});
	});
});
