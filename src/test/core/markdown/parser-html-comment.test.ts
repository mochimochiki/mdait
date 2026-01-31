// HTMLコメント内マーカー挿入問題のテスト
// タスクチケット: 260131_HTMLコメント内マーカー挿入問題修正.md

import { strict as assert } from "node:assert";
import { markdownParser } from "../../../core/markdown/parser";

const testConfig = { sync: { level: 2 } } as unknown as import("../../../config/configuration").Configuration;

suite("MarkdownParser（HTMLコメント内マーカー挿入スキップ）", () => {
	test("単一行HTMLコメント内にマーカーが挿入されないこと", () => {
		const md = `<!-- これは単一行HTMLコメントです -->

## 見出し1

本文テキスト
`;

		const parsed = markdownParser.parse(md, testConfig);

		// HTMLコメントは翻訳対象外なので、見出し1のみがユニットになる
		assert.strictEqual(parsed.units.length, 1);
		assert.strictEqual(parsed.units[0].title, "見出し1");

		// 再構築したMarkdownにHTMLコメントが含まれていることを確認
		const stringified = markdownParser.stringify(parsed);
		assert.match(stringified, /<!-- これは単一行HTMLコメントです -->/);
		// ネストコメントが発生していないことを確認
		assert.doesNotMatch(stringified, /<!-- mdait.*<!-- mdait/);
	});

	test("複数行HTMLコメント内にマーカーが挿入されないこと", () => {
		const md = `<!--
これは複数行のHTMLコメントです。
この中にマーカーが挿入されると
ネストコメントになってしまいます。
-->

## 見出し1

本文テキスト
`;

		const parsed = markdownParser.parse(md, testConfig);

		// HTMLコメントは翻訳対象外なので、見出し1のみがユニットになる
		assert.strictEqual(parsed.units.length, 1);
		assert.strictEqual(parsed.units[0].title, "見出し1");

		// 再構築したMarkdownにHTMLコメントが含まれていることを確認
		const stringified = markdownParser.stringify(parsed);
		assert.match(stringified, /<!--\s*これは複数行のHTMLコメントです/);
		// ネストコメントが発生していないことを確認
		assert.doesNotMatch(stringified, /<!-- mdait.*<!-- mdait/);
	});

	test("mdait管理用マーカーは通常のマーカーとして認識されること", () => {
		const md = `<!-- mdait abc123 -->
## 見出し1

本文テキスト

<!-- mdait def456 -->
## 見出し2

本文テキスト2
`;

		const parsed = markdownParser.parse(md, testConfig);

		// mdaitマーカー付きの見出し2つがユニットになる
		assert.strictEqual(parsed.units.length, 2);
		assert.strictEqual(parsed.units[0].title, "見出し1");
		assert.strictEqual(parsed.units[0].marker.hash, "abc123");
		assert.strictEqual(parsed.units[1].title, "見出し2");
		assert.strictEqual(parsed.units[1].marker.hash, "def456");
	});

	test("HTMLコメントとmdaitマーカーが混在する文書が正しく処理されること", () => {
		const md = `<!-- これはHTMLコメントです -->

<!-- mdait abc123 -->
## 見出し1

本文テキスト

<!--
複数行のHTMLコメント
ここはスキップされるべき
-->

## 見出し2

本文テキスト2
`;

		const parsed = markdownParser.parse(md, testConfig);

		// 見出し1と見出し2の2ユニット
		assert.strictEqual(parsed.units.length, 2);
		assert.strictEqual(parsed.units[0].title, "見出し1");
		assert.strictEqual(parsed.units[0].marker.hash, "abc123");
		assert.strictEqual(parsed.units[1].title, "見出し2");

		// 再構築したMarkdownにHTMLコメントが含まれていることを確認
		const stringified = markdownParser.stringify(parsed);
		assert.match(stringified, /<!-- これはHTMLコメントです -->/);
		assert.match(stringified, /<!--\s*複数行のHTMLコメント/);
		// ネストコメントが発生していないことを確認（同一のHTMLコメント内にmdaitマーカーがない）
		const htmlCommentBlocks = stringified.match(/<!--(?:(?!-->).|\n)*?-->/g) || [];
		for (const block of htmlCommentBlocks) {
			// 各HTMLコメントブロック内にmdaitマーカーが含まれていないことを確認
			if (!block.startsWith("<!-- mdait")) {
				assert.doesNotMatch(block, /<!-- mdait/);
			}
		}
	});

	test("コードブロックとHTMLコメントが混在する文書が正しく処理されること", () => {
		const md = `<!-- HTMLコメント -->

\`\`\`javascript
// これはコードブロック
function test() {
  return "test";
}
\`\`\`

## 見出し1

本文テキスト
`;

		const parsed = markdownParser.parse(md, testConfig);

		// 先頭のコンテンツ（HTMLコメント+コードブロック）と見出し1の2ユニット
		// HTMLコメントのみならスキップされるが、コードブロックがあるため独立したユニットになる
		assert.strictEqual(parsed.units.length, 2);
		assert.strictEqual(parsed.units[1].title, "見出し1");

		// 再構築したMarkdownに両方が含まれていることを確認
		const stringified = markdownParser.stringify(parsed);
		assert.match(stringified, /<!-- HTMLコメント -->/);
		assert.match(stringified, /```javascript/);
		assert.match(stringified, /function test\(\)/);
	});

	test("不完全なHTMLコメント（閉じタグなし）は通常のテキストとして扱われること", () => {
		const md = `<!-- これは閉じタグがないコメント

## 見出し1

本文テキスト
`;

		const parsed = markdownParser.parse(md, testConfig);

		// markdown-itの解釈に従う（通常は見出し1がユニットになる）
		assert.ok(parsed.units.length >= 1);

		const stringified = markdownParser.stringify(parsed);
		// 不完全なコメントがそのまま保持されることを確認
		assert.match(stringified, /<!-- これは閉じタグがないコメント/);
	});

	test("インラインHTMLコメントが適切に処理されること", () => {
		const md = `段落の中に <!-- インラインコメント --> があります。

## 見出し1

本文テキスト
`;

		const parsed = markdownParser.parse(md, testConfig);

		// 見出し1を含むユニット
		assert.ok(parsed.units.length >= 1);

		const stringified = markdownParser.stringify(parsed);
		// インラインコメントが保持されることを確認
		assert.match(stringified, /<!-- インラインコメント -->/);
		// ネストコメントが発生していないことを確認
		assert.doesNotMatch(stringified, /<!-- mdait.*<!-- インラインコメント/);
	});

	test("mdaitマーカーとHTMLコメントが同一行にある場合が適切に処理されること", () => {
		const md = `<!-- HTMLコメント --> <!-- mdait abc123 -->

## 見出し1

本文テキスト
`;

		const parsed = markdownParser.parse(md, testConfig);

		// 見出し1がユニットになる
		assert.strictEqual(parsed.units.length, 1);
		assert.strictEqual(parsed.units[0].title, "見出し1");

		const stringified = markdownParser.stringify(parsed);
		// 両方のコメントが保持されることを確認
		assert.match(stringified, /<!-- HTMLコメント -->/);
		assert.match(stringified, /<!-- mdait/);
	});
});
