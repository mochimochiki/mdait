/**
 * @file dropped-code-blocks.test.ts
 * @description
 *   翻訳結果の `droppedCodeBlocks`（＝本文が失われた件数）が、
 *   別種の警告（JSON 混入検出など）と混ざらないことのテスト。
 *
 *   非Markdown経路はこの値だけを見て `need:review` を立てる。
 *   「警告があること」を条件にすると、.json ファイルや JSON の例を含む .txt を訳すたびに
 *   review が立ち、確認という仕組みそのものが信用されなくなる。
 */

import { strict as assert } from "node:assert";
import { TranslationContext } from "../../../../commands/trans/translation-context";
import { AITranslator } from "../../../../commands/trans/translator";
import type { AIMessage, AIService } from "../../../../infra/llm/ai-service";

class StubAIService implements AIService {
	constructor(private readonly response: string) {}
	async sendMessage(_systemPrompt: string, _messages: AIMessage[]): Promise<string> {
		return this.response;
	}
	getLastSystemPrompt(): string {
		return "";
	}
}

const stubGetPromptParts = () => ({ system: "stub-prompt", userContext: "", isLegacy: true });

function translatorReturning(translation: string): AITranslator {
	return new AITranslator(
		new StubAIService(JSON.stringify({ translation, termSuggestions: [] })),
		"en",
		stubGetPromptParts,
	);
}

suite("droppedCodeBlocks（本文が失われた件数）", () => {
	const context = new TranslationContext();

	test("コードブロックが戻れば 0 になること", async () => {
		const translator = translatorReturning("翻訳文\n__CODE_BLOCK_PLACEHOLDER_0__\n続き");
		const source = ["説明。", "", "```js", "console.log(1);", "```", "", "続き。"].join("\n");

		const result = await translator.translate(source, "ja", "en", context);

		assert.strictEqual(result.droppedCodeBlocks, 0);
		assert.ok(result.translatedText.includes("console.log(1);"));
	});

	test("AI がプレースホルダを消したら件数が立つこと", async () => {
		const translator = translatorReturning("翻訳文だけ返してコードブロックを落とした");
		const source = ["説明。", "", "```js", "console.log(1);", "```", "", "続き。"].join("\n");

		const result = await translator.translate(source, "ja", "en", context);

		assert.strictEqual(result.droppedCodeBlocks, 1);
		assert.ok((result.warnings ?? []).some((w) => w.includes("dropped")));
	});

	test("JSON ファイルの中身が JSON でも件数は 0 のままであること（偽陽性を作らない）", async () => {
		// sanitizeTranslationOutput の JSON 混入検出は「AI が応答のエンベロープを漏らした」を
		// 捕まえる道具なので、JSON そのものを訳すと定義上つねに warning が出る。
		// それを need の根拠にしないことをここで固定する。
		const jsonBody = '{\n  "name": "サンプル",\n  "desc": "説明文"\n}';
		const translator = translatorReturning(jsonBody);
		const jsonContext = new TranslationContext();
		jsonContext.fileExtension = ".json";

		const result = await translator.translate(jsonBody, "ja", "en", jsonContext);

		assert.strictEqual(result.droppedCodeBlocks, 0, "コードブロックは失われていない");
		assert.ok((result.warnings ?? []).length > 0, "警告そのものは出る（ログには残す）");
	});

	test("裸の JSON 例を含む .txt でも件数は 0 のままであること", async () => {
		const body = ["設定例:", "", '{ "name": "サンプル" }', "", "以上。"].join("\n");
		const translator = translatorReturning(body);
		const txtContext = new TranslationContext();
		txtContext.fileExtension = ".txt";

		const result = await translator.translate(body, "ja", "en", txtContext);

		assert.strictEqual(result.droppedCodeBlocks, 0);
	});
});
