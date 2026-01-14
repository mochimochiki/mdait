// テストガイドラインに従いテスト実装します。
// フロントマターの形式保持をテストする

import { strict as assert } from "node:assert";
import { FrontMatter } from "../../../core/markdown/front-matter";

suite("FrontMatter形式保持", () => {
	test("コメント付きフロントマターを編集してもコメントが保持されること", () => {
		const md = `---
# これはタイトルのコメント
title: Original Title
# これは説明のコメント
description: Original Description
---
`;

		const { frontMatter } = FrontMatter.parse(md);
		assert.ok(frontMatter);

		// タイトルを変更
		frontMatter.set("title", "Updated Title");

		// コメントが保持されていること
		const raw = frontMatter.raw;
		assert.match(raw, /# これはタイトルのコメント/, "タイトルのコメントが保持されること");
		assert.match(raw, /# これは説明のコメント/, "説明のコメントが保持されること");
		assert.match(raw, /title: Updated Title/, "タイトルが更新されていること");
		assert.match(raw, /description: Original Description/, "説明は変更されていないこと");
	});

	test("インライン（行末）コメントが保持されること", () => {
		const md = `---
title: Original  # これは行末コメント
description: Test
---
`;

		const { frontMatter } = FrontMatter.parse(md);
		assert.ok(frontMatter);

		frontMatter.set("title", "Updated");

		const raw = frontMatter.raw;
		assert.match(raw, /# これは行末コメント/, "行末コメントが保持されること");
		assert.match(raw, /title: Updated/, "値が更新されていること");
	});

	test("カスタムスペーシングが保持されること", () => {
		const md = `---
title:   "Original"
description:  "Description"
---
`;

		const { frontMatter } = FrontMatter.parse(md);
		assert.ok(frontMatter);

		frontMatter.set("title", "Updated");

		const raw = frontMatter.raw;
		// 元のスペーシングパターンが保持されること
		assert.match(raw, /title: {3}"Updated"/, "タイトルのスペーシングが保持されること");
		assert.match(raw, /description: {2}"Description"/, "descriptionのスペーシングが保持されること");
	});

	test("配列形式が保持されること", () => {
		const md = `---
title: Test
tags:
  - tag1
  - tag2
  - tag3
---
`;

		const { frontMatter } = FrontMatter.parse(md);
		assert.ok(frontMatter);

		frontMatter.set("title", "Updated");

		const raw = frontMatter.raw;
		// 配列形式が保持されること
		assert.match(raw, /tags:\n {2}- tag1\n {2}- tag2\n {2}- tag3/, "配列形式が保持されること");
	});

	test("キーの順序が保持されること", () => {
		const md = `---
zebra: last
apple: first
banana: middle
---
`;

		const { frontMatter } = FrontMatter.parse(md);
		assert.ok(frontMatter);

		frontMatter.set("banana", "updated");

		const raw = frontMatter.raw;
		const lines = raw.split("\n").filter((l) => l.trim() && !l.trim().startsWith("---"));

		// 順序が保持されること（zebra -> apple -> banana）
		assert.strictEqual(lines[0].trim(), "zebra: last");
		assert.strictEqual(lines[1].trim(), "apple: first");
		assert.match(lines[2], /banana: updated/);
	});

	test("複雑なネスト構造の他のキーを編集してもネストが保持されること", () => {
		const md = `---
title: Test
author: Original Author
config:
  nested:
    deep: value
    another: test
  top: level
---
`;

		const { frontMatter } = FrontMatter.parse(md);
		assert.ok(frontMatter);

		// 簡単なキーを編集（ネストした値を編集しない）
		frontMatter.set("author", "Updated Author");

		const raw = frontMatter.raw;
		// ネスト構造が保持されること
		assert.match(raw, /config:\n {2}nested:\n {4}deep: value/, "ネスト構造が保持されること");
		assert.match(raw, /author: Updated Author/, "authorが更新されていること");
	});

	test("引用符のスタイルが保持されること", () => {
		const md = `---
single: 'single quoted'
double: "double quoted"
none: no quotes
---
`;

		const { frontMatter } = FrontMatter.parse(md);
		assert.ok(frontMatter);

		frontMatter.set("double", "updated value");

		const raw = frontMatter.raw;
		// 引用符スタイルが保持されること
		assert.match(raw, /single: 'single quoted'/, "シングルクォートが保持されること");
		assert.match(raw, /none: no quotes/, "引用符なしが保持されること");
	});

	test("空行が保持されること", () => {
		const md = `---
title: Test

description: With empty line above

tags:
  - tag1
---
`;

		const { frontMatter } = FrontMatter.parse(md);
		assert.ok(frontMatter);

		frontMatter.set("title", "Updated");

		const raw = frontMatter.raw;
		// 空行が保持されること（厳密なチェックは難しいが、少なくとも複数の改行があること）
		const emptyLinePattern = /title:.*\n\ndescription:/;
		assert.match(raw, emptyLinePattern, "空行が保持されること");
	});
});
