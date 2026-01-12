// テストガイドラインに従いテスト実装します。
// フロントマター直後に見出しではなく本文が始まる場合のparser挙動をテストする

import { strict as assert } from "node:assert";
import { markdownParser } from "../../../core/markdown/parser";

const testConfig = { sync: { level: 2 } } as unknown as import("../../../config/configuration").Configuration;

suite("MarkdownParser（フロントマター後の本文）", () => {
	test("フロントマター直後が本文の場合、その本文がユニットとして保持されること", () => {
		const md = `---
title: Test Document
---

これはフロントマター直後の本文です。

この内容は最初のユニットに含まれるべきです。

## 見出し1

見出し1の本文
`;

		const parsed = markdownParser.parse(md, testConfig);

		// フロントマター後の本文 + 見出し1 の2ユニットになるべき
		assert.strictEqual(parsed.units.length, 2);

		// 最初のユニットにフロントマター直後の本文が含まれること
		assert.match(parsed.units[0].content, /これはフロントマター直後の本文です/);
		assert.match(parsed.units[0].content, /この内容は最初のユニットに含まれるべきです/);

		// 2番目のユニットは見出し1
		assert.match(parsed.units[1].content, /## 見出し1/);
		assert.match(parsed.units[1].content, /見出し1の本文/);
	});

	test("フロントマター直後にmdaitMarkerがあり、その後に本文がある場合、本文が保持されること", () => {
		const md = `---
title: Test Document
---

<!-- mdait abc123 -->

マーカー直後の本文です。

この内容も保持されるべきです。

## 見出し1

見出し1の本文
`;

		const parsed = markdownParser.parse(md, testConfig);

		// マーカー付きの本文 + 見出し1 の2ユニットになるべき
		assert.strictEqual(parsed.units.length, 2);

		// 最初のユニットにマーカー直後の本文が含まれること
		assert.strictEqual(parsed.units[0].marker.hash, "abc123");
		assert.match(parsed.units[0].content, /マーカー直後の本文です/);
		assert.match(parsed.units[0].content, /この内容も保持されるべきです/);

		// 2番目のユニットは見出し1
		assert.match(parsed.units[1].content, /## 見出し1/);
	});

	test("フロントマター無しで、冒頭が本文の場合も正しく動作すること", () => {
		const md = `冒頭の本文です。

この内容は最初のユニットとして扱われるべきです。

## 見出し1

見出し1の本文
`;

		const parsed = markdownParser.parse(md, testConfig);

		// 冒頭の本文 + 見出し1 の2ユニットになるべき
		assert.strictEqual(parsed.units.length, 2);

		// 最初のユニットに冒頭の本文が含まれること
		assert.match(parsed.units[0].content, /冒頭の本文です/);
		assert.match(parsed.units[0].content, /この内容は最初のユニットとして扱われるべきです/);

		// 2番目のユニットは見出し1
		assert.match(parsed.units[1].content, /## 見出し1/);
	});

	test("フロントマター無しで、冒頭にmdaitMarkerがあり本文が続く場合", () => {
		const md = `<!-- mdait xyz789 -->

冒頭マーカー後の本文です。

## 見出し1

見出し1の本文
`;

		const parsed = markdownParser.parse(md, testConfig);

		// マーカー付きの本文 + 見出し1 の2ユニットになるべき
		assert.strictEqual(parsed.units.length, 2);

		// 最初のユニットにマーカー直後の本文が含まれること
		assert.strictEqual(parsed.units[0].marker.hash, "xyz789");
		assert.match(parsed.units[0].content, /冒頭マーカー後の本文です/);

		// 2番目のユニットは見出し1
		assert.match(parsed.units[1].content, /## 見出し1/);
	});
});
