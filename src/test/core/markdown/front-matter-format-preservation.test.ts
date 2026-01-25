// FrontMatterクラスのフォーマット保持機能のテスト

import { strict as assert } from "node:assert";
import { FrontMatter } from "../../../core/markdown/front-matter";

suite("FrontMatter - フォーマット保持", () => {
	test("mdait管理外のフィールドのフォーマットが保持される", () => {
		const markdown = `---
tags: ["Golang", "Markdown", "Front Matter"]
author: John Doe
date: 2024-01-01
---
Content`;

		const { frontMatter } = FrontMatter.parse(markdown);
		assert.ok(frontMatter, "frontmatterが存在すること");

		// mdaitフィールドを追加
		frontMatter.set("mdait.front", "abc123 from:def456 need:translate");

		const result = frontMatter.stringify();
		console.log("Result:\n", result);

		// 元のフォーマットが保持されているか確認
		assert.ok(
			result.includes('tags: ["Golang", "Markdown", "Front Matter"]'),
			"tags配列のインライン記法が保持されること",
		);
		assert.ok(result.includes("author: John Doe"), "authorフィールドが保持されること");
		assert.ok(result.includes("date: 2024-01-01"), "dateフィールドが保持されること");
		assert.ok(result.includes("mdait:"), "mdaitフィールドが追加されること");
		assert.ok(result.includes("front:"), "mdait.frontフィールドが追加されること");
	});

	test("mdaitフィールドのみが存在する場合でもフォーマットが保持される", () => {
		const markdown = `---
title: Test Title
description: Test description
---
Content`;

		const { frontMatter } = FrontMatter.parse(markdown);
		assert.ok(frontMatter, "frontmatterが存在すること");

		// mdaitフィールドを追加してから削除
		frontMatter.set("mdait.sync.level", 3);
		frontMatter.set("mdait.front", "abc123");
		frontMatter.delete("mdait.front");

		const result = frontMatter.stringify();
		console.log("Result:\n", result);

		// 元のフォーマットが保持されているか確認
		assert.ok(result.includes("title: Test Title"), "titleフィールドが保持されること");
		assert.ok(result.includes("description: Test description"), "descriptionフィールドが保持されること");
		assert.ok(result.includes("mdait:"), "mdaitフィールドが存在すること");
		assert.ok(result.includes("sync:"), "mdait.syncフィールドが存在すること");
	});

	test("mdaitフィールドが先頭にある場合でもフォーマットが保持される", () => {
		const markdown = `---
mdait:
  sync:
    level: 3
title: Test Title
tags: ["Tag1", "Tag2"]
---
Content`;

		const { frontMatter } = FrontMatter.parse(markdown);
		assert.ok(frontMatter, "frontmatterが存在すること");

		// mdaitフィールドを更新
		frontMatter.set("mdait.front", "xyz789");

		const result = frontMatter.stringify();
		console.log("Result:\n", result);

		// 元のフォーマットが保持されているか確認
		assert.ok(result.includes("title: Test Title"), "titleフィールドが保持されること");
		assert.ok(result.includes('tags: ["Tag1", "Tag2"]'), "tags配列のフォーマットが保持されること");
	});

	test("mdaitフィールドが中間にある場合でもフォーマットが保持される", () => {
		const markdown = `---
title: Test Title
mdait:
  sync:
    level: 2
description: Test description
tags: ["A", "B", "C"]
---
Content`;

		const { frontMatter } = FrontMatter.parse(markdown);
		assert.ok(frontMatter, "frontmatterが存在すること");

		// mdaitフィールドを更新
		frontMatter.set("mdait.front", "hash123");
		frontMatter.set("mdait.sync.level", 3); // 値を変更

		const result = frontMatter.stringify();
		console.log("Result:\n", result);

		// 元のフォーマットが保持されているか確認
		assert.ok(result.includes("title: Test Title"), "titleフィールドが保持されること");
		assert.ok(result.includes("description: Test description"), "descriptionフィールドが保持されること");
		assert.ok(result.includes('tags: ["A", "B", "C"]'), "tags配列のフォーマットが保持されること");
		assert.ok(result.includes("mdait:"), "mdaitフィールドが存在すること");
	});

	test("mdaitフィールドが末尾にある場合でもフォーマットが保持される", () => {
		const markdown = `---
title: Test Title
author: Jane Doe
tags: ["X", "Y"]
mdait:
  sync:
    level: 3
---
Content`;

		const { frontMatter } = FrontMatter.parse(markdown);
		assert.ok(frontMatter, "frontmatterが存在すること");

		// mdaitフィールドを更新
		frontMatter.set("mdait.front", "final123");

		const result = frontMatter.stringify();
		console.log("Result:\n", result);

		// 元のフォーマットが保持されているか確認
		assert.ok(result.includes("title: Test Title"), "titleフィールドが保持されること");
		assert.ok(result.includes("author: Jane Doe"), "authorフィールドが保持されること");
		assert.ok(result.includes('tags: ["X", "Y"]'), "tags配列のフォーマットが保持されること");
	});

	test("frontmatterにmdaitが存在しない場合", () => {
		const markdown = `---
title: No Mdait
tags: ["One", "Two"]
complex:
  nested:
    value: 123
---
Content`;

		const { frontMatter } = FrontMatter.parse(markdown);
		assert.ok(frontMatter, "frontmatterが存在すること");

		// mdaitフィールドを新規追加
		frontMatter.set("mdait.front", "new123");
		frontMatter.set("mdait.sync.level", 2);

		const result = frontMatter.stringify();
		console.log("Result:\n", result);

		// 元のフォーマットが保持されているか確認
		assert.ok(result.includes("title: No Mdait"), "titleフィールドが保持されること");
		assert.ok(result.includes('tags: ["One", "Two"]'), "tags配列のフォーマットが保持されること");
		assert.ok(result.includes("complex:"), "complexフィールドが保持されること");
		assert.ok(result.includes("nested:"), "nestedフィールドが保持されること");
		assert.ok(result.includes("mdait:"), "mdaitフィールドが追加されること");
	});

	test("frontmatterがmdaitのみの場合", () => {
		const markdown = `---
mdait:
  sync:
    level: 3
  front: "abc123"
---
Content`;

		const { frontMatter } = FrontMatter.parse(markdown);
		assert.ok(frontMatter, "frontmatterが存在すること");

		// mdaitフィールドを更新
		frontMatter.set("mdait.front", "updated456");
		frontMatter.set("mdait.sync.level", 2);

		const result = frontMatter.stringify();
		console.log("Result:\n", result);

		// mdaitフィールドのみが存在すること
		assert.ok(result.includes("mdait:"), "mdaitフィールドが存在すること");
		assert.ok(result.includes("sync:"), "syncフィールドが存在すること");
		assert.ok(result.includes("front:"), "frontフィールドが存在すること");
	});

	test("複雑なネスト構造を持つfrontmatterでもフォーマットが保持される", () => {
		const markdown = `---
title: Complex Structure
metadata:
  authors: ["Alice", "Bob"]
  tags: ["tech", "tutorial"]
  versions:
    - v1.0
    - v2.0
date: 2024-01-01
---
Content`;

		const { frontMatter } = FrontMatter.parse(markdown);
		assert.ok(frontMatter, "frontmatterが存在すること");

		// mdaitフィールドを追加
		frontMatter.set("mdait.front", "complex123");

		const result = frontMatter.stringify();
		console.log("Result:\n", result);

		// 元のフォーマットが保持されているか確認
		assert.ok(result.includes("title: Complex Structure"), "titleフィールドが保持されること");
		assert.ok(result.includes("metadata:"), "metadataフィールドが保持されること");
		assert.ok(result.includes('authors: ["Alice", "Bob"]'), "authors配列のフォーマットが保持されること");
		assert.ok(result.includes('tags: ["tech", "tutorial"]'), "tags配列のフォーマットが保持されること");
		assert.ok(result.includes("date: 2024-01-01"), "dateフィールドが保持されること");
		assert.ok(result.includes("mdait:"), "mdaitフィールドが追加されること");
	});

	test("mdaitフィールドを削除した場合でも他のフォーマットが保持される", () => {
		const markdown = `---
title: Test
tags: ["A", "B"]
mdait:
  sync:
    level: 3
  front: "abc123"
author: John
---
Content`;

		const { frontMatter } = FrontMatter.parse(markdown);
		assert.ok(frontMatter, "frontmatterが存在すること");

		// mdaitフィールド全体を削除
		frontMatter.delete("mdait");

		const result = frontMatter.stringify();
		console.log("Result:\n", result);

		// 元のフォーマットが保持されているか確認
		assert.ok(result.includes("title: Test"), "titleフィールドが保持されること");
		assert.ok(result.includes('tags: ["A", "B"]'), "tags配列のフォーマットが保持されること");
		assert.ok(result.includes("author: John"), "authorフィールドが保持されること");
		assert.ok(!result.includes("mdait:"), "mdaitフィールドが削除されること");
	});

	test("空白やコメントを含むfrontmatterでもフォーマットが保持される", () => {
		const markdown = `---
title: Test With Spaces

tags: ["Tag1", "Tag2"]

author: Alice
---
Content`;

		const { frontMatter } = FrontMatter.parse(markdown);
		assert.ok(frontMatter, "frontmatterが存在すること");

		// mdaitフィールドを追加
		frontMatter.set("mdait.front", "space123");

		const result = frontMatter.stringify();
		console.log("Result:\n", result);

		// 基本的なフォーマットが保持されているか確認
		assert.ok(result.includes("title: Test With Spaces"), "titleフィールドが保持されること");
		assert.ok(result.includes('tags: ["Tag1", "Tag2"]'), "tags配列のフォーマットが保持されること");
		assert.ok(result.includes("author: Alice"), "authorフィールドが保持されること");
		assert.ok(result.includes("mdait:"), "mdaitフィールドが追加されること");
	});
});
