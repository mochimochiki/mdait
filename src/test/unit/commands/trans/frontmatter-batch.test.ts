/**
 * @file frontmatter-batch.test.ts
 * @description 新しく訳す frontmatter の値を1回で頼む経路（ADR-261109-01）の単体テスト
 */

import { strict as assert } from "node:assert";
import { translateFrontmatterValuesInOneRequest } from "../../../../commands/trans/trans-command";
import type { TranslationContext } from "../../../../commands/trans/translation-context";
import type { TranslationResult, Translator } from "../../../../commands/trans/translator";
import { UnusableAIResponseError } from "../../../../infra/llm/unusable-response";

/** translateBatch だけを使う偽の翻訳サービス */
function fakeTranslator(answer: (texts: readonly string[]) => TranslationResult[] | Error): Translator & {
	batchCalls: string[][];
} {
	const batchCalls: string[][] = [];
	return {
		batchCalls,
		translate: async () => {
			throw new Error("translate は呼ばれないはず");
		},
		translateRevisionPatch: async () => {
			throw new Error("translateRevisionPatch は呼ばれないはず");
		},
		canTranslateBatch: () => true,
		translateBatch: async (texts: readonly string[], _s: string, _t: string, _c: TranslationContext) => {
			batchCalls.push([...texts]);
			const result = answer(texts);
			if (result instanceof Error) {
				throw result;
			}
			return result;
		},
	};
}

suite("frontmatter をまとめて訳す（ADR-261109-01）", () => {
	const values = { title: "警報", description: "しきい値と警報の使い方を説明します。" };

	test("title と description を1回で頼み、キーごとの訳を返す", async () => {
		const translator = fakeTranslator((texts) => texts.map((t) => ({ translatedText: `EN(${t})` })));
		const result = await translateFrontmatterValuesInOneRequest(["title", "description"], values, [], translator, "ja", "en");
		assert.strictEqual(translator.batchCalls.length, 1);
		assert.deepStrictEqual(translator.batchCalls[0], [values.title, values.description]);
		assert.deepStrictEqual(result, { title: `EN(${values.title})`, description: `EN(${values.description})` });
	});

	test("キーが1つだけならまとめない（呼び出し側がキーごとに頼む）", async () => {
		const translator = fakeTranslator((texts) => texts.map((t) => ({ translatedText: t })));
		const result = await translateFrontmatterValuesInOneRequest(["title"], { title: "警報" }, [], translator, "ja", "en");
		assert.strictEqual(result, undefined);
		assert.strictEqual(translator.batchCalls.length, 0);
	});

	test("1行の値が複数行に割れた答えは採らない", async () => {
		const translator = fakeTranslator((texts) => texts.map(() => ({ translatedText: "Alert\nand more" })));
		const result = await translateFrontmatterValuesInOneRequest(["title", "description"], values, [], translator, "ja", "en");
		assert.strictEqual(result, undefined);
	});

	test("まとめた答えが使えなければ、キーごとに頼むよう undefined を返す", async () => {
		const translator = fakeTranslator(() => new UnusableAIResponseError("invalid-format", "bad", "detail"));
		const result = await translateFrontmatterValuesInOneRequest(["title", "description"], values, [], translator, "ja", "en");
		assert.strictEqual(result, undefined);
	});

	test("まとめて頼む経路を持たない翻訳サービスではまとめない", async () => {
		const translator = fakeTranslator((texts) => texts.map((t) => ({ translatedText: t })));
		translator.canTranslateBatch = () => false;
		const result = await translateFrontmatterValuesInOneRequest(["title", "description"], values, [], translator, "ja", "en");
		assert.strictEqual(result, undefined);
		assert.strictEqual(translator.batchCalls.length, 0);
	});
});
