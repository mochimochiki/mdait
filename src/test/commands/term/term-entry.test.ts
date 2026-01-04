/**
 * @file term-entry.test.ts
 * @description TermEntryのテスト実装
 * 言語ベース構造と型安全性の検証
 */

import { strict as assert } from "node:assert";
import { LangTerm, TermEntry } from "../../../commands/term/term-entry";

suite("TermEntry", () => {
	test("新しいTermEntryを作成できる", () => {
		const languages = {
			ja: LangTerm.create("開発プロセス", ["開発 プロセス"]),
			en: LangTerm.create("development process", ["dev proc"]),
		};

		const entry = TermEntry.create("開発全般", languages);

		assert.strictEqual(entry.context, "開発全般");
		assert.strictEqual(TermEntry.getTerm(entry, "ja"), "開発プロセス");
		assert.strictEqual(TermEntry.getTerm(entry, "en"), "development process");
		assert.deepStrictEqual(TermEntry.getvariants(entry, "ja"), ["開発 プロセス"]);
	});

	test("言語リストを正しく取得できる", () => {
		const languages = {
			en: LangTerm.create("test"),
			ja: LangTerm.create("テスト"),
			zh: LangTerm.create("测试"),
		};

		const entry = TermEntry.create("テスト用語", languages);
		const langs = TermEntry.getLanguages(entry);

		assert.deepStrictEqual(langs, ["en", "ja", "zh"]); // ソート済み
	});

	test("言語の存在チェックができる", () => {
		const languages = {
			ja: LangTerm.create("テスト"),
		};

		const entry = TermEntry.create("テスト", languages);

		assert.strictEqual(TermEntry.hasLanguage(entry, "ja"), true);
		assert.strictEqual(TermEntry.hasLanguage(entry, "en"), false);
	});

	test("空のエントリを検知できる", () => {
		const emptyEntry = TermEntry.create("コンテキストのみ", {});
		const nonEmptyEntry = TermEntry.create("テスト", {
			ja: LangTerm.create("テスト"),
		});

		assert.strictEqual(TermEntry.isEmpty(emptyEntry), true);
		assert.strictEqual(TermEntry.isEmpty(nonEmptyEntry), false);
	});

	test("重複検知が正しく動作する", () => {
		const entry1 = TermEntry.create("テスト1", {
			ja: LangTerm.create("テスト"),
			en: LangTerm.create("test"),
		});

		const entry2 = TermEntry.create("テスト2", {
			ja: LangTerm.create("試験"), // 異なる日本語
			en: LangTerm.create("test"), // 同じ英語
		});

		const entry3 = TermEntry.create("テスト3", {
			ja: LangTerm.create("試験"), // 異なる用語
			en: LangTerm.create("exam"),
		});

		// 英語（primaryLang）で重複
		assert.strictEqual(TermEntry.isDuplicate(entry1, entry2, "en"), true);
		// 英語で重複なし
		assert.strictEqual(TermEntry.isDuplicate(entry1, entry3, "en"), false);
	});

	test("エントリのマージができる", () => {
		const entry1 = TermEntry.create("元のコンテキスト", {
			ja: LangTerm.create("テスト"),
		});

		const entry2 = TermEntry.create("新しいコンテキスト", {
			en: LangTerm.create("test"),
		});

		const merged = TermEntry.merge(entry1, entry2);

		assert.strictEqual(merged.context, "元のコンテキスト");
		assert.strictEqual(TermEntry.getTerm(merged, "ja"), "テスト");
		assert.strictEqual(TermEntry.getTerm(merged, "en"), "test");
	});
});

suite("LanguageTermInfo", () => {
	test("新しいLanguageTermInfoを作成できる", () => {
		const info = LangTerm.create("テスト", ["試験", "テスト用"]);

		assert.strictEqual(info.term, "テスト");
		assert.deepStrictEqual(info.variants, ["試験", "テスト用"]);
	});

	test("空白文字が適切に処理される", () => {
		const info = LangTerm.create("  テスト  ", ["  試験  ", "", "  "]);

		assert.strictEqual(info.term, "テスト");
		assert.deepStrictEqual(info.variants, ["試験"]); // 空文字除去
	});
});
