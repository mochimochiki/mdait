// コードブロック内のマーカー風文字列を本文として扱う（design.md P9）
// 利用者が「マーカーの書き方」をコードブロックで説明している文書を壊さないこと。

import { strict as assert } from "node:assert";
import { markdownParser } from "../../../../core/markdown/parser";

const testConfig = { sync: { level: 2 } } as unknown as import("../../../../infra/config/configuration").Configuration;

const CODE_DOC = [
	"# ドキュメント",
	"",
	"導入の文章。",
	"",
	"## コード例",
	"",
	"マーカーの書き方は次のとおりです。",
	"",
	"```markdown",
	"<!-- mdait 12345678 from:87654321 need:translate -->",
	"## サンプル章",
	"",
	"サンプルの本文。",
	"```",
	"",
	"## 第2章",
	"",
	"第2章の本文。",
	"",
].join("\n");

suite("MarkdownParser（コードブロック内のマーカー風文字列）", () => {
	test("コードブロックの中に空行が挿入されないこと", () => {
		const parsed = markdownParser.parse(CODE_DOC, testConfig);
		const stringified = markdownParser.stringify(parsed);

		assert.ok(
			stringified.includes("```markdown\n<!-- mdait 12345678 from:87654321 need:translate -->"),
			`コードブロックの中身が書き換わっている:\n${stringified}`,
		);
	});

	test("コードブロック内のマーカー風文字列はユニット境界にならないこと", () => {
		const parsed = markdownParser.parse(CODE_DOC, testConfig);

		assert.strictEqual(parsed.units.length, 3);
		assert.deepStrictEqual(
			parsed.units.map((u) => u.title),
			["ドキュメント", "コード例", "第2章"],
		);
	});

	test("コードブロック内のマーカー風文字列でハッシュが揺れないこと（parse→stringify が冪等）", () => {
		const once = markdownParser.stringify(markdownParser.parse(CODE_DOC, testConfig));
		const twice = markdownParser.stringify(markdownParser.parse(once, testConfig));

		assert.strictEqual(twice, once);
	});

	test("コードブロックの外にあるマーカーは従来どおり境界になる（空行が無くても）", () => {
		const md = [
			"# ドキュメント",
			"",
			"導入の文章。",
			"<!-- mdait aaaaaaaa -->",
			"## 第2章",
			"",
			"第2章の本文。",
			"",
		].join("\n");

		const parsed = markdownParser.parse(md, testConfig);

		assert.strictEqual(parsed.units.length, 2);
		assert.strictEqual(parsed.units[1].title, "第2章");
		assert.strictEqual(parsed.units[1].marker?.hash, "aaaaaaaa");
	});
});
