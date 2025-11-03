/**
 * @file term-extractor.test.ts
 * @description TermExtractorのテスト実装
 * 用語抽出とJSON変換ロジックの検証
 */

import { strict as assert } from "node:assert";
import { LangTerm, TermEntry } from "../../../commands/term/term-entry";
import { extractRelevantTerms, termsToJson } from "../../../commands/trans/term-extractor";

suite("TermExtractor", () => {
	suite("extractRelevantTerms", () => {
		test("ユニット内容に含まれる用語を抽出できる", () => {
			const unitContent = "This document describes the development process and unit test strategy.";
			const allTerms = [
				TermEntry.create("開発", {
					en: LangTerm.create("development process"),
					ja: LangTerm.create("開発プロセス"),
				}),
				TermEntry.create("単体テスト", {
					en: LangTerm.create("unit test"),
					ja: LangTerm.create("単体テスト"),
				}),
				TermEntry.create("該当なし", {
					en: LangTerm.create("not applicable"),
					ja: LangTerm.create("該当なし"),
				}),
			];

			const result = extractRelevantTerms(unitContent, allTerms, "en", "ja");

			assert.strictEqual(result.length, 2);
			assert.strictEqual(result[0].term, "development process");
			assert.strictEqual(result[0].translation, "開発プロセス");
			assert.strictEqual(result[1].term, "unit test");
			assert.strictEqual(result[1].translation, "単体テスト");
		});

		test("variantsに一致する用語も抽出できる", () => {
			const unitContent = "This system uses dev process with CI pipeline.";
			const allTerms = [
				TermEntry.create("開発", {
					en: LangTerm.create("development process", ["dev process", "dev proc"]),
					ja: LangTerm.create("開発プロセス"),
				}),
			];

			const result = extractRelevantTerms(unitContent, allTerms, "en", "ja");

			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0].term, "development process");
			assert.strictEqual(result[0].translation, "開発プロセス");
		});

		test("原語または訳語がない場合はスキップする", () => {
			const unitContent = "This document uses term A and term B.";
			const allTerms = [
				TermEntry.create("用語A", {
					en: LangTerm.create("term A"),
					// jaなし
				}),
				TermEntry.create("用語B", {
					// enなし
					ja: LangTerm.create("用語B"),
				}),
			];

			const result = extractRelevantTerms(unitContent, allTerms, "en", "ja");

			assert.strictEqual(result.length, 0);
		});

		test("contextがある場合はTranslationTermに含める", () => {
			const unitContent = "Refer to the API documentation.";
			const allTerms = [
				TermEntry.create("プログラミング用語", {
					en: LangTerm.create("API"),
					ja: LangTerm.create("API"),
				}),
			];

			const result = extractRelevantTerms(unitContent, allTerms, "en", "ja");

			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0].context, "プログラミング用語");
		});
	});

	suite("termsToJson", () => {
		test("用語リストをJSON文字列に変換できる", () => {
			const terms = [
				{ term: "development process", translation: "開発プロセス" },
				{ term: "unit test", translation: "単体テスト" },
			];

			const json = termsToJson(terms);
			const parsed = JSON.parse(json);

			assert.strictEqual(parsed.length, 2);
			assert.strictEqual(parsed[0].term, "development process");
			assert.strictEqual(parsed[0].translation, "開発プロセス");
		});

		test("contextがある場合はJSON出力に含める", () => {
			const terms = [
				{
					term: "API",
					translation: "API",
					context: "プログラミング用語",
				},
			];

			const json = termsToJson(terms);
			const parsed = JSON.parse(json);

			assert.strictEqual(parsed[0].context, "プログラミング用語");
		});

		test("contextがundefinedの場合はJSON出力に含めない", () => {
			const terms = [
				{
					term: "test",
					translation: "テスト",
					context: undefined,
				},
			];

			const json = termsToJson(terms);
			const parsed = JSON.parse(json);

			assert.strictEqual(Object.prototype.hasOwnProperty.call(parsed[0], "context"), false);
		});

		test("空の用語リストは空文字列を返す", () => {
			const json = termsToJson([]);

			assert.strictEqual(json, "");
		});
	});
});
