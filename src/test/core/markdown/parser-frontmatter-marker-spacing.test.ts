// テストガイドラインに従いテスト実装します。
// frontmatterとmdaitマーカーの間に余分な空白行が挿入されないことをテストする

import { strict as assert } from "node:assert";
import { markdownParser } from "../../../core/markdown/parser";

const testConfig = {
	sync: { level: 2 },
} as unknown as import("../../../config/configuration").Configuration;

suite("MarkdownParser（frontmatter-マーカー空白行）", () => {
	test("frontmatter直後にmdaitマーカーがある場合、空白行が挿入されないこと（1回目のsync想定）", () => {
		const md = `---
title: Test Document
---
<!-- mdait abc123 -->

# Heading 1

Content here.
`;

		const parsed = markdownParser.parse(md, testConfig);
		const stringified = markdownParser.stringify(parsed);

		console.log("=== 1回目のstringify結果 ===");
		console.log(stringified);

		// frontmatterの直後にマーカーがあり、空白行が挿入されていないことを確認
		const lines = stringified.split("\n");
		let frontmatterEndIndex = -1;
		for (let i = 0; i < lines.length; i++) {
			if (lines[i] === "---" && i > 0) {
				frontmatterEndIndex = i;
				break;
			}
		}

		assert.ok(frontmatterEndIndex >= 0, "frontmatterの終了行が見つかること");

		// frontmatterの次の行がマーカーであることを確認
		const nextLineAfterFrontmatter = lines[frontmatterEndIndex + 1];
		assert.ok(
			nextLineAfterFrontmatter.includes("<!-- mdait"),
			`frontmatter直後の行がマーカーであること。実際: "${nextLineAfterFrontmatter}"`,
		);
	});

	test("frontmatter直後にmdaitマーカーがある場合、2回のparse→stringify後も空白行が挿入されないこと", () => {
		const md = `---
title: Test Document
---
<!-- mdait abc123 -->

# Heading 1

Content here.
`;

		// 1回目のparse→stringify
		const parsed1 = markdownParser.parse(md, testConfig);
		const stringified1 = markdownParser.stringify(parsed1);

		console.log("=== 1回目のstringify結果 ===");
		console.log(stringified1);

		// 2回目のparse→stringify
		const parsed2 = markdownParser.parse(stringified1, testConfig);
		const stringified2 = markdownParser.stringify(parsed2);

		console.log("=== 2回目のstringify結果 ===");
		console.log(stringified2);

		// frontmatterとマーカーの間に空白行がないことを確認
		const lines = stringified2.split("\n");
		let frontmatterEndIndex = -1;
		for (let i = 0; i < lines.length; i++) {
			if (lines[i] === "---" && i > 0) {
				frontmatterEndIndex = i;
				break;
			}
		}

		assert.ok(frontmatterEndIndex >= 0, "frontmatterの終了行が見つかること");

		// frontmatterの次の行がマーカーであることを確認（空白行ではない）
		const nextLineAfterFrontmatter = lines[frontmatterEndIndex + 1];
		assert.ok(
			nextLineAfterFrontmatter.includes("<!-- mdait"),
			`frontmatter直後の行がマーカーであること。実際: "${nextLineAfterFrontmatter}"`,
		);

		// 1回目と2回目の結果が同じであることを確認（冪等性）
		assert.strictEqual(stringified1, stringified2, "2回のstringify結果が同じであること");
	});

	test("frontmatter直後に見出しがある場合（マーカーなし）も正しく動作すること", () => {
		const md = `---
title: Test Document
---

# Heading

Content here without marker.
`;

		const parsed = markdownParser.parse(md, testConfig);
		const stringified = markdownParser.stringify(parsed);

		console.log("=== 見出しから始まる場合 ===");
		console.log(stringified);
		console.log("Parsed units:", parsed.units.length);

		// 見出しがある場合はユニットとして認識される
		assert.ok(stringified.includes("---"), "frontmatterが含まれること");
		assert.ok(parsed.units.length > 0, "ユニットが存在すること");
		if (parsed.units.length > 0) {
			assert.ok(parsed.units[0].title === "Heading", "見出しがタイトルとして認識されること");
		}
	});

	test("複数ユニットがある場合でも、frontmatter直後のマーカーに空白行が挿入されないこと", () => {
		const md = `---
title: Test Document
---
<!-- mdait abc123 -->

# Heading 1

Content 1.

<!-- mdait def456 -->

# Heading 2

Content 2.
`;

		const parsed = markdownParser.parse(md, testConfig);
		const stringified = markdownParser.stringify(parsed);

		console.log("=== 複数ユニット ===");
		console.log(stringified);

		// frontmatterの直後にマーカーがあり、空白行が挿入されていないことを確認
		const lines = stringified.split("\n");
		let frontmatterEndIndex = -1;
		for (let i = 0; i < lines.length; i++) {
			if (lines[i] === "---" && i > 0) {
				frontmatterEndIndex = i;
				break;
			}
		}

		assert.ok(frontmatterEndIndex >= 0, "frontmatterの終了行が見つかること");

		// frontmatterの次の行がマーカーであることを確認
		const nextLineAfterFrontmatter = lines[frontmatterEndIndex + 1];
		assert.ok(
			nextLineAfterFrontmatter.includes("<!-- mdait"),
			`frontmatter直後の行がマーカーであること。実際: "${nextLineAfterFrontmatter}"`,
		);
	});
});
