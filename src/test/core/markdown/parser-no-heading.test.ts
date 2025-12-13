// core/markdown/parser の「見出しがない位置のmdaitマーカー」挙動を固定するテスト
// テストガイドラインに従いテスト実装します。

import { strict as assert } from "node:assert";
import { markdownParser } from "../../../core/markdown/parser";

const testConfig = { sync: { autoMarkerLevel: 2 } } as unknown as import("../../../config/configuration").Configuration;

suite("MarkdownParser（見出し無しマーカー）", () => {
	test("見出し無し位置のmdaitマーカーが先頭ユニットとしてパースされること", () => {
		const md = `<!-- mdait abcd1234 -->

本文A

# 見出し1

本文B
`;

		const parsed = markdownParser.parse(md, testConfig);

		// 先頭ユニット（見出し無し）と、見出しユニットの2ユニットになる想定
		assert.strictEqual(parsed.units.length, 2);
		assert.strictEqual(parsed.units[0].marker.hash, "abcd1234");
		assert.match(parsed.units[0].content, /本文A/);
		assert.match(parsed.units[1].content, /# 見出し1/);
	});

	test("見出し無しユニットが次の見出しの手前にある場合、独立ユニットとしてパースされること", () => {
		const md = `# 見出し0

本文0

<!-- mdait abcd1234 -->

見出し無し本文A

## 見出し1

本文1
`;

		const parsed = markdownParser.parse(md, testConfig);

		// 見出し0 / 見出し無し / 見出し1 の3ユニット
		assert.strictEqual(parsed.units.length, 3);
		assert.match(parsed.units[0].content, /# 見出し0/);
		assert.strictEqual(parsed.units[1].marker.hash, "abcd1234");
		assert.match(parsed.units[1].content, /見出し無し本文A/);
		assert.match(parsed.units[2].content, /## 見出し1/);
	});

	test("途中に複数の見出し無しマーカーがある場合、それぞれ独立ユニットとしてパースされること", () => {
		const md = `# 見出し0

本文0

<!-- mdait abcd1234 -->

見出し無し本文A

<!-- mdait bcde2345 -->

見出し無し本文B

## 見出し1

本文1
`;

		const parsed = markdownParser.parse(md, testConfig);

		// 見出し0 / 見出し無しA / 見出し無しB / 見出し1 の4ユニット
		assert.strictEqual(parsed.units.length, 4);
		assert.match(parsed.units[0].content, /# 見出し0/);
		assert.strictEqual(parsed.units[1].marker.hash, "abcd1234");
		assert.match(parsed.units[1].content, /見出し無し本文A/);
		assert.strictEqual(parsed.units[2].marker.hash, "bcde2345");
		assert.match(parsed.units[2].content, /見出し無し本文B/);
		assert.match(parsed.units[3].content, /## 見出し1/);
	});
});
