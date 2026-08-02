import { strict as assert } from "node:assert";
import { applySimplePatch, createUnifiedDiff, hasDiff } from "../../../../core/diff/diff-generator";

suite("DiffGenerator", () => {
	test("createUnifiedDiff: 基本的な差分を生成する", () => {
		const oldContent = "Hello World";
		const newContent = "Hello New World";

		const diff = createUnifiedDiff(oldContent, newContent);

		// unified diff形式のヘッダを含む
		assert.ok(diff.includes("---"));
		assert.ok(diff.includes("+++"));
		assert.ok(diff.includes("@@"));
		// 変更内容を含む
		assert.ok(diff.includes("-Hello World"));
		assert.ok(diff.includes("+Hello New World"));
	});

	test("createUnifiedDiff: 同一コンテンツの場合は変更なしの差分を生成する", () => {
		const content = "Hello World";

		const diff = createUnifiedDiff(content, content);

		// ヘッダは含むが変更行は含まない
		assert.ok(diff.includes("---"));
		assert.ok(!diff.includes("-Hello World"));
		assert.ok(!diff.includes("+Hello World"));
	});

	test("createUnifiedDiff: 複数行の差分を生成する", () => {
		const oldContent = `Line 1
Line 2
Line 3`;
		const newContent = `Line 1
Modified Line 2
Line 3`;

		const diff = createUnifiedDiff(oldContent, newContent);

		assert.ok(diff.includes("-Line 2"));
		assert.ok(diff.includes("+Modified Line 2"));
	});

	test("hasDiff: 差分の有無を正しく判定する", () => {
		assert.equal(hasDiff("Hello", "Hello"), false);
		assert.equal(hasDiff("Hello", "World"), true);
		assert.equal(hasDiff("", ""), false);
		assert.equal(hasDiff("", "Hello"), true);
	});
});

/** 成功した適用結果からテキストを取り出す（失敗なら明示的に落とす） */
function patchedText(result: ReturnType<typeof applySimplePatch>): string {
	assert.equal(result.ok, true, "パッチ適用が成功していること");
	return result.ok ? result.text : "";
}

suite("applySimplePatch", () => {
	test("空パッチは失敗理由 empty-patch を返す", () => {
		const applied = applySimplePatch("Hello", "");
		assert.equal(applied.ok, false);
		assert.equal(applied.ok === false && applied.reason, "empty-patch");
	});

	test("=/-/+ 形式でないパッチは失敗理由 unrecognized-format を返す", () => {
		const applied = applySimplePatch("Hello", "@@ -1 +1 @@\n-Hello\n+Hi");
		assert.equal(applied.ok, false);
		assert.equal(applied.ok === false && applied.reason, "unrecognized-format");
	});

	test("変更行が無いパッチは失敗理由 no-changes を返す", () => {
		const applied = applySimplePatch("Hello", "=Hello");
		assert.equal(applied.ok, false);
		assert.equal(applied.ok === false && applied.reason, "no-changes");
	});

	test("目印の行が見つからないときは失敗理由 anchor-not-found を返す", () => {
		const base = "Line 1\nLine 2\n";
		const patch = `=Nonexistent context
-Line 2
+New Line 2`;

		const applied = applySimplePatch(base, patch);
		assert.equal(applied.ok, false);
		assert.equal(applied.ok === false && applied.reason, "anchor-not-found");
	});

	test("末尾空白の差異を吸収するfuzzyマッチ", () => {
		const base = "Line 1  \nLine 2\n";
		const patch = `=Line 1
-Line 2
+New Line 2`;

		const applied = applySimplePatch(base, patch);
		assert.equal(applied.ok, true);
		assert.ok(patchedText(applied).includes("New Line 2"));
	});

	test("context-onlyフォールバック: old行が不正でもcontextで位置特定して適用する", () => {
		const base =
			'## Test File 2\n\n> This is a quote.\n\nCode block:\n\n```\nconsole.log("Hello, World!");\n```\n\nImage:\n\n![Sample Image](https://via.placeholder.com/150)\n';
		const patch = `=## Test File 2
=
-> This is a revised quote. It includes an important note.
+> This is a revised quote. It includes an important note.
=
=Code block:
=
=\`\`\`
=console.log("Hello, World!");
=\`\`\`
=
=Image:
=
=![Sample Image](https://via.placeholder.com/150)`;

		const applied = applySimplePatch(base, patch);
		assert.notEqual(applied, null, "context-onlyフォールバックが動作するべき");
		assert.ok(patchedText(applied).includes("> This is a revised quote."), "新しい翻訳が含まれるべき");
		assert.ok(patchedText(applied).includes("## Test File 2"), "コンテキストが保持されるべき");
		assert.ok(patchedText(applied).includes("Code block:"), "後続のコンテキストが保持されるべき");
	});

	// ===== Prefixed mode（=プレフィックス） =====
	test("prefixed mode: 基本的な変更を適用できる", () => {
		const base = "## Introduction\nThis is a sample document.\n> Original quote here.\nSome more text.\n";
		const patch = `=## Introduction
=This is a sample document.
-> Original quote here.
+> Updated quote with new meaning.
=Some more text.`;

		const applied = applySimplePatch(base, patch);
		assert.equal(applied.ok, true);
		assert.ok(patchedText(applied).includes("> Updated quote with new meaning."));
		assert.ok(patchedText(applied).includes("## Introduction"));
		assert.ok(patchedText(applied).includes("Some more text."));
	});

	test("prefixed mode: リスト項目がコンテキストにある場合に正しく動作する", () => {
		const base = "## Features\n\n- Translation support\n- Sync support\n- Term management\n";
		const patch = `=## Features
=
=- Translation support
-- Sync support
+- Real-time sync
=- Term management`;

		const applied = applySimplePatch(base, patch);
		assert.equal(applied.ok, true);
		assert.equal(patchedText(applied), "## Features\n\n- Translation support\n- Real-time sync\n- Term management\n");
	});

	test("prefixed mode: リスト項目の追加（insert-only）", () => {
		const base = "## Features\n\n- Translation support\n- Sync support\n";
		const patch = `=## Features
=
=- Translation support
=- Sync support
+- Term management`;

		const applied = applySimplePatch(base, patch);
		assert.equal(applied.ok, true);
		assert.ok(patchedText(applied).includes("- Translation support"));
		assert.ok(patchedText(applied).includes("- Sync support"));
		assert.ok(patchedText(applied).includes("- Term management"));
	});

	test("prefixed mode: リスト項目の削除（delete-only）", () => {
		const base = "## Features\n\n- Translation support\n- Sync support\n- Term management\n";
		const patch = `=## Features
=
=- Translation support
-- Sync support
=- Term management`;

		const applied = applySimplePatch(base, patch);
		assert.equal(applied.ok, true);
		assert.ok(patchedText(applied).includes("- Translation support"));
		assert.ok(!patchedText(applied).includes("- Sync support"));
		assert.ok(patchedText(applied).includes("- Term management"));
	});

	test("prefixed mode: 水平線（---）がコンテキストにある場合", () => {
		const base = "Section 1\n\n---\n\nSection 2\n";
		const patch = `=Section 1
=
=---
=
-Section 2
+Updated Section 2`;

		const applied = applySimplePatch(base, patch);
		assert.equal(applied.ok, true);
		assert.ok(patchedText(applied).includes("---"));
		assert.ok(patchedText(applied).includes("Updated Section 2"));
		assert.ok(!patchedText(applied).includes("\nSection 2\n"));
	});

	test("prefixed mode: 複数チャンクの変更", () => {
		const base = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\n";
		const patch = `=Line 1
-Line 2
+Modified 2
=Line 3
=Line 4
=Line 5
-Line 6
+Modified 6
=Line 7`;

		const applied = applySimplePatch(base, patch);
		assert.equal(applied.ok, true);
		assert.ok(patchedText(applied).includes("Modified 2"));
		assert.ok(patchedText(applied).includes("Modified 6"));
		assert.ok(patchedText(applied).includes("Line 3"));
		assert.ok(patchedText(applied).includes("Line 4"));
		assert.ok(patchedText(applied).includes("Line 5"));
	});

	test("prefixed mode: 空行を含むコンテキスト", () => {
		const base = "Paragraph 1\n\nParagraph 2\n\nParagraph 3\n";
		const patch = `=Paragraph 1
=
-Paragraph 2
+Updated Paragraph 2
=
=Paragraph 3`;

		const applied = applySimplePatch(base, patch);
		assert.equal(applied.ok, true);
		assert.ok(patchedText(applied).includes("Updated Paragraph 2"));
		assert.ok(patchedText(applied).includes("Paragraph 1"));
		assert.ok(patchedText(applied).includes("Paragraph 3"));
	});

	test("prefixed mode: LLMが空行の=プレフィックスを忘れた場合", () => {
		const base = "## Title\n\nContent here.\n";
		const patch = `=## Title

-Content here.
+Updated content.`;

		const applied = applySimplePatch(base, patch);
		assert.equal(applied.ok, true);
		assert.ok(patchedText(applied).includes("Updated content."));
	});

	test("prefixed mode: blockquoteの変更", () => {
		const base = "## Notes\n\n> Important note.\n> Second line.\n\nMore text.\n";
		const patch = `=## Notes
=
-> Important note.
+> Updated important note.
=> Second line.
=
=More text.`;

		const applied = applySimplePatch(base, patch);
		assert.equal(applied.ok, true);
		assert.ok(patchedText(applied).includes("> Updated important note."));
		assert.ok(patchedText(applied).includes("> Second line."));
	});

	test("prefixed mode: タスクリストの変更", () => {
		const base = "## TODO\n\n- [ ] Task 1\n- [x] Task 2\n- [ ] Task 3\n";
		const patch = `=## TODO
=
=- [ ] Task 1
-- [x] Task 2
+- [x] Updated Task 2
=- [ ] Task 3`;

		const applied = applySimplePatch(base, patch);
		assert.equal(applied.ok, true);
		assert.ok(patchedText(applied).includes("- [x] Updated Task 2"));
		assert.ok(patchedText(applied).includes("- [ ] Task 1"));
		assert.ok(patchedText(applied).includes("- [ ] Task 3"));
	});
});
