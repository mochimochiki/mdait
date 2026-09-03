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
import { UnusableAIResponseError } from "../../../../infra/llm/unusable-response";

class StubAIService implements AIService {
	constructor(private readonly response: string) {}
	async sendMessage(_systemPrompt: string, _messages: AIMessage[]): Promise<string> {
		return this.response;
	}
	getLastSystemPrompt(): string {
		return "";
	}
}

/** 何回聞かれたかを数える版（送り直しの有無を見るため） */
class CountingStubAIService implements AIService {
	callCount = 0;
	constructor(private readonly response: string) {}
	async sendMessage(_systemPrompt: string, _messages: AIMessage[]): Promise<string> {
		this.callCount++;
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

	test("JSON ファイルの翻訳は1往復で終わり、訳文にエンベロープが混ざらないこと", async () => {
		// 検証の JSON 混入検出は Markdown 以外では必ず偽陽性になる（訳す対象が JSON だから）。
		// 見に行くと、正しい応答を3回とも「形が違う」と落としたうえで失敗になる。
		// ここは「1往復で成功し、訳文は本文そのもの」を固定する。
		const jsonBody = '{\n  "name": "サンプル"\n}';
		const service = new CountingStubAIService(JSON.stringify({ translation: jsonBody, termSuggestions: [] }));
		const translator = new AITranslator(service, "en", stubGetPromptParts);
		const jsonContext = new TranslationContext();
		jsonContext.fileExtension = ".json";

		const result = await translator.translate(jsonBody, "ja", "en", jsonContext);

		assert.strictEqual(service.callCount, 1, "送り直していないこと（費用を3倍にしない）");
		assert.strictEqual(result.translatedText, jsonBody, "エンベロープではなく本文が訳文になること");
	});

	test("裸の JSON 例を含む .txt でも件数は 0 のままであること", async () => {
		const body = ["設定例:", "", '{ "name": "サンプル" }', "", "以上。"].join("\n");
		const translator = translatorReturning(body);
		const txtContext = new TranslationContext();
		txtContext.fileExtension = ".txt";

		const result = await translator.translate(body, "ja", "en", txtContext);

		assert.strictEqual(result.droppedCodeBlocks, 0);
	});

	test("Markdown では本文への JSON 混入をこれまでどおり失敗として扱うこと", async () => {
		// 偽陽性を消すために検出そのものを外していないことの裏取り。
		// Markdown ではフェンス付きコードブロックが先に退避されるので、
		// 本文に残った `{"translation": ...}` は「AI がエンベロープを漏らした」しかない。
		const service = new CountingStubAIService(JSON.stringify({ translation: '{"translation": "ネストされた"}' }));
		const translator = new AITranslator(service, "en", stubGetPromptParts);

		const error = await translator.translate("本文。", "ja", "en", new TranslationContext()).then(
			() => undefined,
			(e: unknown) => e,
		);

		assert.ok(error instanceof UnusableAIResponseError, "使えない答えとして投げること");
		assert.strictEqual(error.reason, "invalid-format");
	});
});
