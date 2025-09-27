/**
 * @file term-entry-converter.test.ts
 * @description CSV⇔TermEntry変換のテスト実装
 */

import { strict as assert } from "node:assert";
import { LangTerm, TermEntry } from "../../../commands/term/term-entry";
import { TermEntryConverter } from "../../../commands/term/term-entry-converter";

suite("TermEntryConverter", () => {
	test("CSVロウからTermEntryを作成できる", () => {
		const csvRow = {
			ja: "開発プロセス",
			variants_ja: "開発 プロセス,開発のプロセス",
			en: "development process",
			variants_en: "dev proc",
			context: "開発全般",
		};

		const entry = TermEntryConverter.fromCsvRow(csvRow, ["ja", "en"]);

		assert.strictEqual(entry.context, "開発全般");
		assert.strictEqual(TermEntry.getTerm(entry, "ja"), "開発プロセス");
		assert.strictEqual(TermEntry.getTerm(entry, "en"), "development process");
		assert.deepStrictEqual(TermEntry.getvariants(entry, "ja"), ["開発 プロセス", "開発のプロセス"]);
		assert.deepStrictEqual(TermEntry.getvariants(entry, "en"), ["dev proc"]);
	});

	test("TermEntryからCSVロウを作成できる", () => {
		const entry = TermEntry.create("開発全般", {
			ja: LangTerm.create("開発プロセス", ["開発 プロセス", "開発のプロセス"]),
			en: LangTerm.create("development process", ["dev proc"]),
		});

		const csvRow = TermEntryConverter.toCsvRow(entry, ["ja", "en"]);

		assert.strictEqual(csvRow.context, "開発全般");
		assert.strictEqual(csvRow.ja, "開発プロセス");
		assert.strictEqual(csvRow.en, "development process");
		assert.strictEqual(csvRow.variants_ja, "開発 プロセス,開発のプロセス");
		assert.strictEqual(csvRow.variants_en, "dev proc");
	});

	test("二重引用符を含む表記揺れが正しく処理される", () => {
		const csvRow = {
			ja: "テスト",
			variants_ja: '"テスト""項目",試験',
			en: "test",
			context: "テスト用語",
		};

		const entry = TermEntryConverter.fromCsvRow(csvRow, ["ja", "en"]);
		const backToCsv = TermEntryConverter.toCsvRow(entry, ["ja", "en"]);

		// 往復変換で内容が保持される
		assert.deepStrictEqual(TermEntry.getvariants(entry, "ja"), ['テスト"項目', "試験"]);
		assert.strictEqual(backToCsv.variants_ja, '"テスト""項目,試験"');
	});

	test("空の表記揺れが正しく処理される", () => {
		const entry = TermEntry.create("テスト", {
			ja: LangTerm.create("テスト", []),
			en: LangTerm.create("test", []),
		});

		const csvRow = TermEntryConverter.toCsvRow(entry, ["ja", "en"]);

		assert.strictEqual(csvRow.variants_ja, "");
		assert.strictEqual(csvRow.variants_en, "");
	});

	test("CSVヘッダーから言語リストを抽出できる", () => {
		const headers = ["ja", "variants_ja", "en", "variants_en", "context", "zh"];
		const languages = TermEntryConverter.extractLanguagesFromHeaders(headers);

		assert.deepStrictEqual(languages, ["en", "ja", "zh"]); // ソート済み、context除外
	});

	test("存在しない言語の処理", () => {
		const csvRow = {
			ja: "テスト",
			context: "テスト用語",
		};

		const entry = TermEntryConverter.fromCsvRow(csvRow, ["ja", "en", "zh"]);

		assert.strictEqual(TermEntry.getTerm(entry, "ja"), "テスト");
		assert.strictEqual(TermEntry.getTerm(entry, "en"), undefined);
		assert.strictEqual(TermEntry.getTerm(entry, "zh"), undefined);
		assert.strictEqual(TermEntry.hasLanguage(entry, "ja"), true);
		assert.strictEqual(TermEntry.hasLanguage(entry, "en"), false);
	});

	test("部分的な言語情報の往復変換", () => {
		const entry = TermEntry.create("テスト", {
			ja: LangTerm.create("テスト"),
			// en は存在しない
		});

		const csvRow = TermEntryConverter.toCsvRow(entry, ["ja", "en", "zh"]);

		assert.strictEqual(csvRow.ja, "テスト");
		assert.strictEqual(csvRow.en, "");
		assert.strictEqual(csvRow.zh, "");
		assert.strictEqual(csvRow.variants_ja, "");
		assert.strictEqual(csvRow.variants_en, "");
		assert.strictEqual(csvRow.variants_zh, "");
	});
});
