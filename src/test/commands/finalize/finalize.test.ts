import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { Configuration } from "../../../config/configuration";
import { markdownParser } from "../../../core/markdown/parser";

suite("Finalize Command", () => {
	const testDir = path.join(__dirname, "../../workspace/finalize-test");
	const testFile = path.join(testDir, "test-finalize.md");

	setup(() => {
		// テストディレクトリを作成
		if (!fs.existsSync(testDir)) {
			fs.mkdirSync(testDir, { recursive: true });
		}
	});

	teardown(() => {
		// テストファイルを削除
		if (fs.existsSync(testFile)) {
			fs.unlinkSync(testFile);
		}
	});

	test("マーカーが正しく削除される", () => {
		// テスト用Markdownを作成
		const markdownContent = `<!-- mdait abc12345 from:def67890 need:translate -->
## Test Heading

This is a test content.

<!-- mdait xyz98765 -->
## Another Heading

Another content here.`;

		fs.writeFileSync(testFile, markdownContent, "utf-8");

		// パースして確認
		const config = Configuration.getInstance();
		const markdown = markdownParser.parse(markdownContent, config);

		// ユニット数を確認
		assert.equal(markdown.units.length, 2, "2つのユニットが存在すべき");

		// 各ユニットにマーカーが存在することを確認
		assert.ok(markdown.units[0].marker.hash, "最初のユニットにハッシュが存在すべき");
		assert.ok(markdown.units[1].marker.hash, "2番目のユニットにハッシュが存在すべき");

		// マーカーを除去した文字列を生成
		const resultLines: string[] = [];
		for (const unit of markdown.units) {
			resultLines.push(unit.content);
		}
		const result = `${resultLines.join("\n\n").trimEnd()}\n`;

		// 結果を確認
		assert.ok(!result.includes("<!-- mdait"), "mdaitマーカーが含まれていないこと");
		assert.ok(result.includes("## Test Heading"), "見出しが保持されていること");
		assert.ok(result.includes("This is a test content."), "コンテンツが保持されていること");
		assert.ok(result.includes("## Another Heading"), "2番目の見出しが保持されていること");
		assert.ok(result.includes("Another content here."), "2番目のコンテンツが保持されていること");
	});

	test("FrontMatterが保持される", () => {
		// FrontMatter付きMarkdownを作成
		const markdownContent = `---
title: Test Document
lang: ja
---

<!-- mdait abc12345 -->
## Heading

Content here.`;

		fs.writeFileSync(testFile, markdownContent, "utf-8");

		const config = Configuration.getInstance();
		const markdown = markdownParser.parse(markdownContent, config);

		// FrontMatterを含めた結果を生成
		const resultLines: string[] = [];
		if (markdown.frontMatter && !markdown.frontMatter.isEmpty()) {
			resultLines.push(markdown.frontMatter.raw);
		}
		for (const unit of markdown.units) {
			resultLines.push(unit.content);
		}
		const result = `${resultLines.join("\n\n").trimEnd()}\n`;

		// 結果を確認
		assert.ok(result.includes("---"), "FrontMatterの区切りが保持されていること");
		assert.ok(result.includes("title: Test Document"), "FrontMatterの内容が保持されていること");
		assert.ok(!result.includes("<!-- mdait"), "mdaitマーカーが含まれていないこと");
		assert.ok(result.includes("## Heading"), "見出しが保持されていること");
	});

	test("マーカーのないMarkdownはそのまま", () => {
		// マーカーなしMarkdownを作成
		const markdownContent = `## Simple Heading

Simple content without markers.`;

		fs.writeFileSync(testFile, markdownContent, "utf-8");

		const config = Configuration.getInstance();
		const markdown = markdownParser.parse(markdownContent, config);

		// マーカーを除去した文字列を生成（実際にはマーカーがないので変化なし）
		const resultLines: string[] = [];
		for (const unit of markdown.units) {
			resultLines.push(unit.content);
		}
		const result = `${resultLines.join("\n\n").trimEnd()}\n`;

		// 結果を確認
		assert.ok(result.includes("## Simple Heading"), "見出しが保持されていること");
		assert.ok(result.includes("Simple content without markers."), "コンテンツが保持されていること");
	});
});
