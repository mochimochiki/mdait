// FrontMatterクラスのフォーマット保持機能のテスト

import { strict as assert } from "node:assert";
import { FrontMatter } from "../../../../core/markdown/front-matter";

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

	test("non-mdaitフィールドの値を更新した場合、更新が反映され他のフォーマットは保持される", () => {
		const markdown = `---
title: Original Title
tags: ["Golang", "Markdown"]
description: Original description
author: John
---
Content`;

		const { frontMatter } = FrontMatter.parse(markdown);
		assert.ok(frontMatter, "frontmatterが存在すること");

		// titleを更新（翻訳を想定）
		frontMatter.set("title", "Translated Title");

		const result = frontMatter.stringify();
		console.log("Result:\n", result);

		// 更新したtitleが反映されていること
		assert.ok(result.includes("title: Translated Title"), "titleが更新されていること");
		assert.ok(!result.includes("Original Title"), "元のtitleが残っていないこと");

		// 他のフィールドは元のフォーマットが保持されていること
		assert.ok(result.includes('tags: ["Golang", "Markdown"]'), "tags配列のフォーマットが保持されること");
		assert.ok(result.includes("description: Original description"), "descriptionが保持されること");
		assert.ok(result.includes("author: John"), "authorが保持されること");
	});

	test("複数のnon-mdaitフィールドを更新した場合、すべての更新が反映される", () => {
		const markdown = `---
title: Title
description: Description
tags: ["A", "B"]
author: Author
---
Content`;

		const { frontMatter } = FrontMatter.parse(markdown);
		assert.ok(frontMatter, "frontmatterが存在すること");

		// 複数のフィールドを更新
		frontMatter.set("title", "New Title");
		frontMatter.set("description", "New Description");

		const result = frontMatter.stringify();
		console.log("Result:\n", result);

		// 更新したフィールドが反映されていること
		assert.ok(result.includes("title: New Title"), "titleが更新されていること");
		assert.ok(result.includes("description: New Description"), "descriptionが更新されていること");

		// 他のフィールドは保持されていること
		assert.ok(result.includes('tags: ["A", "B"]'), "tagsが保持されること");
		assert.ok(result.includes("author: Author"), "authorが保持されること");
	});

	test("non-mdaitフィールドとmdaitフィールドを同時に更新した場合、両方が反映される", () => {
		const markdown = `---
title: Original
tags: ["X", "Y"]
mdait:
  sync:
    level: 2
---
Content`;

		const { frontMatter } = FrontMatter.parse(markdown);
		assert.ok(frontMatter, "frontmatterが存在すること");

		// 両方を更新
		frontMatter.set("title", "Updated Title");
		frontMatter.set("mdait.front", "hash123");

		const result = frontMatter.stringify();
		console.log("Result:\n", result);

		// 両方の更新が反映されていること
		assert.ok(result.includes("title: Updated Title"), "titleが更新されていること");
		assert.ok(result.includes("front:"), "mdait.frontが追加されていること");
		assert.ok(result.includes('tags: ["X", "Y"]'), "tagsが保持されること");
	});

	test("non-mdaitフィールドを更新しても元の順序が保持される", () => {
		const markdown = `---
title: Original Title
description: Original description
tags: ["A", "B"]
author: John
---
Content`;

		const { frontMatter } = FrontMatter.parse(markdown);
		assert.ok(frontMatter, "frontmatterが存在すること");

		// titleを更新（翻訳を想定）
		frontMatter.set("title", "Translated Title");

		const result = frontMatter.stringify();
		console.log("Result:\n", result);

		// 順序を確認：title → description → tags → author の順
		const titleIdx = result.indexOf("title:");
		const descIdx = result.indexOf("description:");
		const tagsIdx = result.indexOf("tags:");
		const authorIdx = result.indexOf("author:");

		assert.ok(titleIdx < descIdx, "titleがdescriptionより前にあること");
		assert.ok(descIdx < tagsIdx, "descriptionがtagsより前にあること");
		assert.ok(tagsIdx < authorIdx, "tagsがauthorより前にあること");

		// 値も正しく更新されていること
		assert.ok(result.includes("title: Translated Title"), "titleが更新されていること");
		assert.ok(result.includes("description: Original description"), "descriptionが保持されること");
	});

	test("複数のnon-mdaitフィールドを更新しても順序が保持される", () => {
		const markdown = `---
title: Title
description: Description
category: Category
tags: ["X"]
author: Author
---
Content`;

		const { frontMatter } = FrontMatter.parse(markdown);
		assert.ok(frontMatter, "frontmatterが存在すること");

		// 複数フィールドを更新
		frontMatter.set("title", "New Title");
		frontMatter.set("description", "New Description");

		const result = frontMatter.stringify();
		console.log("Result:\n", result);

		// 順序を確認
		const titleIdx = result.indexOf("title:");
		const descIdx = result.indexOf("description:");
		const catIdx = result.indexOf("category:");
		const tagsIdx = result.indexOf("tags:");
		const authorIdx = result.indexOf("author:");

		assert.ok(titleIdx < descIdx, "titleがdescriptionより前にあること");
		assert.ok(descIdx < catIdx, "descriptionがcategoryより前にあること");
		assert.ok(catIdx < tagsIdx, "categoryがtagsより前にあること");
		assert.ok(tagsIdx < authorIdx, "tagsがauthorより前にあること");

		// 値も正しく更新されていること
		assert.ok(result.includes("title: New Title"), "titleが更新されていること");
		assert.ok(result.includes("description: New Description"), "descriptionが更新されていること");
		assert.ok(result.includes("category: Category"), "categoryが保持されること");
	});
});

/**
 * 引用符の付け方は原稿のものなので、値を差し替えるついでに変えない。
 *
 * 背景: 翻訳対象の frontmatter キー（`trans.frontmatter.keys`）は、訳が変わっていなくても
 * 毎回 `set()` を通る。値を書き出す `formatSimpleValue` が「YAML として必要なときだけ
 * 引用符を付ける」作りだったため、**改訂を1回通しただけで `title: "..."` が `title: ...` へ
 * 変わった**（実測。実 LLM で見本サイトの改訂を通したとき、差し替えたのは description だけ
 * なのに title の引用符まで落ちた）。原稿を預ける相手にとっては、内容が同じでも
 * 「勝手に書き換わった」ことに変わりはない（ADR-260902-01 / -260903-02 と同じ理由）。
 */
suite("FrontMatter - 引用符の付け方を保つ", () => {
	/** 差し替えたあとの1行を取り出す */
	function lineOf(result: string, key: string): string {
		const line = result.split("\n").find((l) => l.startsWith(`${key}:`));
		assert.ok(line, `${key} の行が見つからない`);
		return line;
	}

	test("二重引用符の値を差し替えても、二重引用符のままであること", () => {
		const { frontMatter } = FrontMatter.parse('---\ntitle: "Old Title"\n---\nContent');
		assert.ok(frontMatter);
		frontMatter.set("title", "New Title");
		assert.equal(lineOf(frontMatter.stringify(), "title"), 'title: "New Title"');
	});

	test("一重引用符の値を差し替えても、一重引用符のままであること", () => {
		const { frontMatter } = FrontMatter.parse("---\ntitle: 'Old Title'\n---\nContent");
		assert.ok(frontMatter);
		frontMatter.set("title", "New Title");
		assert.equal(lineOf(frontMatter.stringify(), "title"), "title: 'New Title'");
	});

	test("裸の値は裸のままであること（引用符を足しもしない）", () => {
		const { frontMatter } = FrontMatter.parse("---\ntitle: Old Title\n---\nContent");
		assert.ok(frontMatter);
		frontMatter.set("title", "New Title");
		assert.equal(lineOf(frontMatter.stringify(), "title"), "title: New Title");
	});

	test("差し替えていないキーの引用符が落ちないこと（実測で壊れた形）", () => {
		const { frontMatter } = FrontMatter.parse(
			'---\ntitle: "Kumo Note Documentation"\ndescription: "A guide."\nweight: 1\n---\nContent',
		);
		assert.ok(frontMatter);
		// 訳が変わらなくても、翻訳対象のキーは毎回 set() を通る
		frontMatter.set("title", "Kumo Note Documentation");
		frontMatter.set("description", "A guide. From introduction to daily usage.");
		const result = frontMatter.stringify();
		assert.equal(lineOf(result, "title"), 'title: "Kumo Note Documentation"');
		assert.equal(lineOf(result, "description"), 'description: "A guide. From introduction to daily usage."');
		assert.equal(lineOf(result, "weight"), "weight: 1", "触っていない行が動いている");
	});

	test("引用符の中に同じ引用符が来ても、読み直せる形で書くこと", () => {
		const withDouble = FrontMatter.parse('---\ntitle: "Old"\n---\nContent').frontMatter;
		assert.ok(withDouble);
		withDouble.set("title", 'He said "hello"');
		// stringify() は区切りの `---` まで返すので、そのまま本文を足せば1つの文書になる
		const reparsedDouble = FrontMatter.parse(`${withDouble.stringify()}\nContent`).frontMatter;
		assert.equal(reparsedDouble?.get("title"), 'He said "hello"', "二重引用符の中の引用符が壊れている");

		const withSingle = FrontMatter.parse("---\ntitle: 'Old'\n---\nContent").frontMatter;
		assert.ok(withSingle);
		withSingle.set("title", "It's here");
		const reparsedSingle = FrontMatter.parse(`${withSingle.stringify()}\nContent`).frontMatter;
		assert.equal(reparsedSingle?.get("title"), "It's here", "一重引用符の中の引用符が壊れている");
	});
});
