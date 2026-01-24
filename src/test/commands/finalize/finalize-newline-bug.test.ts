import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { Configuration } from "../../../config/configuration";
import { markdownParser } from "../../../core/markdown/parser";

suite("Finalize Command - Newline Bug Test", () => {
	const testDir = path.join(__dirname, "../../workspace/finalize-newline-test");
	const testFile = path.join(testDir, "test-newlines.md");

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

	test("finalize後に改行数が増えないこと", () => {
		const config = Configuration.getInstance();

		// マーカー付きMarkdownを作成（末尾の改行に注意）
		const originalContent = `---
title: Test
---

<!-- mdait abc123 -->
## Heading 1

Content 1.

<!-- mdait def456 -->
## Heading 2

Content 2.
`;

		fs.writeFileSync(testFile, originalContent, "utf-8");

		// 元のファイルの改行数をカウント
		const originalNewlineCount = (originalContent.match(/\n/g) || []).length;
		const originalLength = originalContent.length;

		// Finalize処理を模倣
		const markdown = markdownParser.parse(originalContent, config);
		const resultLines: string[] = [];
		if (markdown.frontMatter && !markdown.frontMatter.isEmpty()) {
			resultLines.push(markdown.frontMatter.raw);
		}
		for (const unit of markdown.units) {
			// コンテンツの末尾の改行を除去してから追加
			resultLines.push(unit.content.replace(/\n+$/g, ""));
		}
		// FrontMatterがある場合とない場合で処理を分ける
		let finalized: string;
		if (markdown.frontMatter && !markdown.frontMatter.isEmpty()) {
			const frontMatter = resultLines.shift() || "";
			finalized = `${frontMatter}${resultLines.join("\n\n")}\n`;
		} else {
			finalized = `${resultLines.join("\n\n")}\n`;
		}

		// finalize後のファイルの改行数をカウント
		const finalizedNewlineCount = (finalized.match(/\n/g) || []).length;
		const finalizedLength = finalized.length;

		// デバッグ情報を出力
		console.log("\n=== Newline Bug Test Debug Info ===");
		console.log("Original length:", originalLength);
		console.log("Original newlines:", originalNewlineCount);
		console.log("Finalized length:", finalizedLength);
		console.log("Finalized newlines:", finalizedNewlineCount);
		console.log("Difference in length:", finalizedLength - originalLength);
		console.log("Difference in newlines:", finalizedNewlineCount - originalNewlineCount);
		console.log("\n=== Original Content ===");
		console.log(JSON.stringify(originalContent));
		console.log("\n=== Finalized Content ===");
		console.log(JSON.stringify(finalized));
		console.log("===========================\n");

		// 検証: 改行数が増えていないこと
		assert.ok(
			finalizedNewlineCount <= originalNewlineCount,
			`finalize後に改行が増えています: 元=${originalNewlineCount}, finalize後=${finalizedNewlineCount}`,
		);
	});

	test("マーカーのみのファイルでfinalize後に改行数が増えないこと", () => {
		const config = Configuration.getInstance();

		// シンプルなマーカー付きMarkdown
		const originalContent = `<!-- mdait abc123 -->
## Heading

Content.
`;

		fs.writeFileSync(testFile, originalContent, "utf-8");

		const originalNewlineCount = (originalContent.match(/\n/g) || []).length;

		// Finalize処理
		const markdown = markdownParser.parse(originalContent, config);
		const resultLines: string[] = [];
		for (const unit of markdown.units) {
			// コンテンツの末尾の改行を除去してから追加
			resultLines.push(unit.content.replace(/\n+$/g, ""));
		}
		const finalized = `${resultLines.join("\n\n")}\n`;

		const finalizedNewlineCount = (finalized.match(/\n/g) || []).length;

		console.log("\n=== Simple Test Debug Info ===");
		console.log("Original:", JSON.stringify(originalContent));
		console.log("Finalized:", JSON.stringify(finalized));
		console.log("Original newlines:", originalNewlineCount);
		console.log("Finalized newlines:", finalizedNewlineCount);
		console.log("===========================\n");

		assert.ok(
			finalizedNewlineCount <= originalNewlineCount,
			`finalize後に改行が増えています: 元=${originalNewlineCount}, finalize後=${finalizedNewlineCount}`,
		);
	});
});
