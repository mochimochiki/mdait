// core/markdown/parser の「見出しがない位置のmdaitマーカー」挙動を固定するテスト
// テストガイドラインに従いテスト実装します。

import { strict as assert } from "node:assert";
import { markdownParser } from "../../../core/markdown/parser";

const testConfig = { sync: { level: 2 } } as unknown as import("../../../config/configuration").Configuration;

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

	test("ハッシュが省略されたマーカーでも境界としてパースされること", () => {
		const md = `# 見出し0

本文0

<!-- mdait -->

手動で追加したユニット

## 見出し1

本文1
`;

		const parsed = markdownParser.parse(md, testConfig);

		// 見出し0 / 手動追加ユニット / 見出し1 の3ユニット
		assert.strictEqual(parsed.units.length, 3);
		assert.match(parsed.units[0].content, /# 見出し0/);
		// ハッシュは空文字列
		assert.strictEqual(parsed.units[1].marker.hash, "");
		assert.match(parsed.units[1].content, /手動で追加したユニット/);
		assert.match(parsed.units[2].content, /## 見出し1/);
	});

	test("ハッシュ省略マーカーの後に見出しがある場合でも正しく統合されること", () => {
		const md = `# 見出し0

本文0

<!-- mdait -->
## 手動で追加した見出し

本文A

## 見出し1

本文1
`;

		const parsed = markdownParser.parse(md, testConfig);

		// 見出し0 / 手動追加見出し / 見出し1 の3ユニット
		assert.strictEqual(parsed.units.length, 3);
		assert.match(parsed.units[0].content, /# 見出し0/);
		// マーカーと見出しが統合される
		assert.strictEqual(parsed.units[1].marker.hash, "");
		assert.strictEqual(parsed.units[1].title, "手動で追加した見出し");
		assert.match(parsed.units[1].content, /## 手動で追加した見出し/);
		assert.match(parsed.units[2].content, /## 見出し1/);
	});

	test("複数のハッシュ省略マーカーが連続する場合でも正しくパースされること", () => {
		const md = `# 見出し0

本文0

<!-- mdait -->

ユニットA

<!-- mdait -->

ユニットB

<!-- mdait -->

ユニットC

## 見出し1

本文1
`;

		const parsed = markdownParser.parse(md, testConfig);

		// 見出し0 / ユニットA / ユニットB / ユニットC / 見出し1 の5ユニット
		assert.strictEqual(parsed.units.length, 5);
		assert.match(parsed.units[0].content, /# 見出し0/);
		assert.strictEqual(parsed.units[1].marker.hash, "");
		assert.match(parsed.units[1].content, /ユニットA/);
		assert.strictEqual(parsed.units[2].marker.hash, "");
		assert.match(parsed.units[2].content, /ユニットB/);
		assert.strictEqual(parsed.units[3].marker.hash, "");
		assert.match(parsed.units[3].content, /ユニットC/);
		assert.match(parsed.units[4].content, /## 見出し1/);
	});

	test("本文から始まるユニットの先頭空行が除去されること", () => {
		const md = `---
title: first-empty-marker-test
---

<!-- mdait 153aab38 -->

本文が最初

<!-- mdait a48035d4 -->
## テストファイル

> これは引用です。
`;

		const parsed = markdownParser.parse(md, testConfig);

		assert.strictEqual(parsed.units.length, 2);
		assert.strictEqual(parsed.units[0].marker.hash, "153aab38");
		assert.strictEqual(parsed.units[0].content.split("\n")[0], "本文が最初");

		const stringified = markdownParser.stringify(parsed);
		assert.match(stringified, /<!-- mdait 153aab38 -->\n本文が最初/);
	});

	test("先頭に複数空行があっても除去されること", () => {
		const md = `---
title: first-empty-marker-test
---

<!-- mdait 99999999 -->



本文が最初

次の行

<!-- mdait aaaaaaaa -->
## 見出し
`;

		const parsed = markdownParser.parse(md, testConfig);

		assert.strictEqual(parsed.units.length, 2);
		assert.strictEqual(parsed.units[0].marker.hash, "99999999");
		const contentLines = parsed.units[0].content.split("\n");
		assert.strictEqual(contentLines[0], "本文が最初");
		assert.strictEqual(contentLines[1], "");
		assert.strictEqual(contentLines[2], "次の行");

		const stringified = markdownParser.stringify(parsed);
		assert.match(stringified, /<!-- mdait 99999999 -->\n本文が最初\n\n次の行/);
	});
});
