import { strict as assert } from "node:assert";
import { applyUnifiedPatch, createUnifiedDiff, hasDiff, stripDiffHeader } from "../../../core/diff/diff-generator";

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

	test("stripDiffHeader: ヘッダ行を除去する", () => {
		const diff = `--- content
+++ content
@@ -1 +1 @@
-Hello World
+Hello New World`;

		const stripped = stripDiffHeader(diff);

		// @@から始まる
		assert.ok(stripped.startsWith("@@"));
		// ---や+++は含まない
		assert.ok(!stripped.includes("--- content"));
		assert.ok(!stripped.includes("+++ content"));
	});

	test("hasDiff: 差分の有無を正しく判定する", () => {
		assert.equal(hasDiff("Hello", "Hello"), false);
		assert.equal(hasDiff("Hello", "World"), true);
		assert.equal(hasDiff("", ""), false);
		assert.equal(hasDiff("", "Hello"), true);
	});

	test("applyUnifiedPatch: ヘッダ付きパッチを適用できる", () => {
		const base = "Line 1\nLine 2\n";
		const patch = `--- content
+++ content
@@ -1,2 +1,2 @@
-Line 1
+Line One
 Line 2`;

		const applied = applyUnifiedPatch(base, patch);
		assert.equal(applied, "Line One\nLine 2\n");
	});

	test("applyUnifiedPatch: ヘッダなしパッチを補完して適用できる", () => {
		const base = "Alpha\nBeta\n";
		const patch = `@@ -1,2 +1,2 @@
-Alpha
+Alpha Prime
 Beta`;

		const applied = applyUnifiedPatch(base, patch, "sample");
		assert.equal(applied, "Alpha Prime\nBeta\n");
	});

	test("applyUnifiedPatch: 空パッチはnullを返す", () => {
		const applied = applyUnifiedPatch("Hello", "\n");
		assert.equal(applied, null);
	});
});
