// テストガイドラインに従いテスト実装します。
// フロントマターのみからなるMDファイルのparser挙動をテストする

import { strict as assert } from "node:assert";
import { markdownParser } from "../../../core/markdown/parser";

const testConfig = { sync: { autoMarkerLevel: 2 } } as unknown as import("../../../config/configuration").Configuration;

suite("MarkdownParser（フロントマターのみ）", () => {
	test("フロントマターのみのMDファイルをパースした場合、frontMatterが保持されること", () => {
		const md = `---
_build:
  list: false
---
`;

		const parsed = markdownParser.parse(md, testConfig);

		// フロントマターが正しく解析されること
		assert.ok(parsed.frontMatter);
		assert.strictEqual(parsed.frontMatter._build?.list, false);
		
		// frontMatterRawも保持されること
		assert.ok(parsed.frontMatterRaw);
		assert.match(parsed.frontMatterRaw, /---/);
		assert.match(parsed.frontMatterRaw, /_build:/);
		
		// ユニットは空であること（本文がないため）
		assert.strictEqual(parsed.units.length, 0);
	});

	test("フロントマターのみのMDファイルをstringifyした場合、フロントマターが保持されること", () => {
		const md = `---
_build:
  list: false
---
`;

		const parsed = markdownParser.parse(md, testConfig);
		const stringified = markdownParser.stringify(parsed);

		// stringifyした結果にフロントマターが含まれること
		assert.match(stringified, /---/);
		assert.match(stringified, /_build:/);
		assert.match(stringified, /list: false/);
		
		// 再度パースして元のデータと一致すること
		const reparsed = markdownParser.parse(stringified, testConfig);
		assert.ok(reparsed.frontMatter);
		assert.strictEqual(reparsed.frontMatter._build?.list, false);
		assert.strictEqual(reparsed.units.length, 0);
	});

	test("フロントマターのみで末尾に改行がない場合も正しく処理されること", () => {
		// 末尾の改行を削除
		const md = `---
_build:
  list: false
---`;

		const parsed = markdownParser.parse(md, testConfig);

		// フロントマターが正しく解析されること
		assert.ok(parsed.frontMatter);
		assert.strictEqual(parsed.frontMatter._build?.list, false);
		
		// ユニットは空であること
		assert.strictEqual(parsed.units.length, 0);
	});

	test("フロントマターのみのMDファイルをparse→stringify→parseしても内容が保持されること", () => {
		const md = `---
title: Test Document
_build:
  list: false
tags:
  - test
  - frontmatter
---
`;

		const parsed1 = markdownParser.parse(md, testConfig);
		const stringified = markdownParser.stringify(parsed1);
		const parsed2 = markdownParser.parse(stringified, testConfig);

		// フロントマターの内容が保持されること
		assert.ok(parsed2.frontMatter);
		assert.strictEqual(parsed2.frontMatter.title, "Test Document");
		assert.strictEqual(parsed2.frontMatter._build?.list, false);
		assert.deepStrictEqual(parsed2.frontMatter.tags, ["test", "frontmatter"]);
		
		// ユニットは空であること
		assert.strictEqual(parsed2.units.length, 0);
	});

	test("空のフロントマターのみの場合も正しく処理されること", () => {
		const md = `---
---
`;

		const parsed = markdownParser.parse(md, testConfig);

		// frontMatterはオブジェクトとして存在すること（空でも）
		assert.ok(parsed.frontMatter);
		assert.strictEqual(Object.keys(parsed.frontMatter).length, 0);
		
		// ユニットは空であること
		assert.strictEqual(parsed.units.length, 0);
		
		// stringify後も構造が保持されること
		const stringified = markdownParser.stringify(parsed);
		const reparsed = markdownParser.parse(stringified, testConfig);
		assert.strictEqual(reparsed.units.length, 0);
	});
});
