import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { Configuration } from "../../../config/configuration";
import { markdownParser } from "../../../core/markdown/parser";

suite("Finalize Command - Marker Removal", () => {
	const testDir = path.join(__dirname, "../../workspace/finalize-test");
	const testFile = path.join(testDir, "test-finalize-behavior.md");

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

	test("finalizeによりマーカーが完全に削除される", () => {
		const config = Configuration.getInstance();

		// マーカー付きMarkdownを作成
		const sourceContent = `<!-- mdait a1b2c3d4 from:xyz12345 need:translate -->
## Heading 1

Content 1.

<!-- mdait e5f6g7h8 -->
## Heading 2

Content 2.`;

		fs.writeFileSync(testFile, sourceContent, "utf-8");

		// Finalize処理を模倣
		const markdown = markdownParser.parse(sourceContent, config);
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

		// 検証: マーカーが削除されている
		assert.ok(!finalized.includes("<!-- mdait"), "全てのmdaitマーカーが削除されている");
		assert.ok(!finalized.includes("from:"), "fromフィールドも削除されている");
		assert.ok(!finalized.includes("need:"), "needフィールドも削除されている");
		
		// 検証: コンテンツは保持されている
		assert.ok(finalized.includes("## Heading 1"), "見出し1が保持されている");
		assert.ok(finalized.includes("Content 1."), "コンテンツ1が保持されている");
		assert.ok(finalized.includes("## Heading 2"), "見出し2が保持されている");
		assert.ok(finalized.includes("Content 2."), "コンテンツ2が保持されている");
	});

	test("finalize後のファイルは通常のMarkdownとして扱える", () => {
		const config = Configuration.getInstance();

		// マーカー付きMarkdownを作成
		const sourceContent = `<!-- mdait a1b2c3d4 -->
## Section

This is content.`;

		// Finalize処理を模倣
		const markdown = markdownParser.parse(sourceContent, config);
		const resultLines: string[] = [];
		for (const unit of markdown.units) {
			// コンテンツの末尾の改行を除去してから追加
			resultLines.push(unit.content.replace(/\n+$/g, ""));
		}
		const finalized = `${resultLines.join("\n\n")}\n`;

		// finalize後のファイルを再度パース（マーカーなしとして）
		const reparsed = markdownParser.parse(finalized, config);
		
		// マーカーのないユニットとして扱われる
		assert.equal(reparsed.units.length, 1, "1つのユニットとして認識される");
		assert.equal(reparsed.units[0].marker.hash, "", "ハッシュは空（マーカーなし）");
		assert.ok(reparsed.units[0].content.includes("## Section"), "見出しが保持されている");
	});
});
