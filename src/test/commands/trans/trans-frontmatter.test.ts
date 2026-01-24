// テストガイドラインに従いテスト実装します。
// transコマンドでfrontmatterが翻訳されることを確認するテスト

import { strict as assert } from "node:assert";
import type { Configuration } from "../../../config/configuration";
import { FrontMatter } from "../../../core/markdown/front-matter";
import {
	getFrontmatterTranslationValues,
	parseFrontmatterMarker,
	setFrontmatterMarker,
} from "../../../core/markdown/frontmatter-translation";
import { MdaitMarker } from "../../../core/markdown/mdait-marker";
import { markdownParser } from "../../../core/markdown/parser";

const testConfig = {
	sync: { level: 2 },
	trans: {
		frontmatter: {
			keys: ["title", "description"],
		},
	},
} as unknown as Configuration;

suite("Trans処理（frontmatter翻訳）", () => {
	test("frontmatterのneed:translateフラグが正しく検出されること", () => {
		const targetMd = `---
title: Test Document
description: This is a test
mdait.front: abc123 from:def456 need:translate
---

<!-- mdait 111111 from:111111 -->
## Heading 1

Translated content
`;

		const target = markdownParser.parse(targetMd, testConfig);
		assert.ok(target.frontMatter);

		const marker = parseFrontmatterMarker(target.frontMatter);
		assert.ok(marker, "mdait.frontマーカーが存在すること");
		assert.ok(marker.needsTranslation(), "needsTranslation()がtrueを返すこと");
		assert.strictEqual(marker.need, "translate");
	});

	test("frontmatterが翻訳済みの場合、needsTranslation()がfalseを返すこと", () => {
		const targetMd = `---
title: Translated Document
description: This is translated
mdait.front: abc123 from:def456
---

## Heading 1

Translated content
`;

		const target = markdownParser.parse(targetMd, testConfig);
		assert.ok(target.frontMatter);

		const marker = parseFrontmatterMarker(target.frontMatter);
		assert.ok(marker);
		assert.strictEqual(marker.needsTranslation(), false, "needsTranslation()がfalseを返すこと");
		assert.strictEqual(marker.need, null);
	});

	test("need:revise@{hash}形式が正しく検出されること", () => {
		const targetMd = `---
title: Test Document
description: This is a test
mdait.front: abc123 from:def456 need:revise@oldhash
---

## Heading 1

Content
`;

		const target = markdownParser.parse(targetMd, testConfig);
		assert.ok(target.frontMatter);

		const marker = parseFrontmatterMarker(target.frontMatter);
		assert.ok(marker);
		assert.ok(marker.needsTranslation(), "needsTranslation()がtrueを返すこと（reviseも翻訳が必要）");
		assert.ok(marker.needsRevision(), "needsRevision()がtrueを返すこと");
		assert.strictEqual(marker.getOldHashFromNeed(), "oldhash", "古いハッシュが取得できること");
	});

	test("MdaitMarker.removeNeedTagで翻訳完了を表現できること", () => {
		const frontMatter = FrontMatter.fromData({
			title: "Test",
			description: "Test description",
		});
		const marker = new MdaitMarker("abc123", "def456", "translate");
		setFrontmatterMarker(frontMatter, marker);

		// マーカーを確認
		const parsedBefore = parseFrontmatterMarker(frontMatter);
		assert.ok(parsedBefore?.needsTranslation());

		// needを削除
		marker.removeNeedTag();
		setFrontmatterMarker(frontMatter, marker);

		// needが削除されていることを確認
		const parsedAfter = parseFrontmatterMarker(frontMatter);
		assert.ok(parsedAfter);
		assert.strictEqual(parsedAfter.needsTranslation(), false);
		assert.strictEqual(parsedAfter.need, null);
	});

	test("翻訳対象値が正しく抽出されること", () => {
		const frontMatter = FrontMatter.fromData({
			title: "Test Title",
			description: "Test Description",
			tags: ["tag1", "tag2"],
			count: 5,
		});

		const values = getFrontmatterTranslationValues(frontMatter, ["title", "description", "tags", "count"]);

		// 文字列のみが翻訳対象
		assert.deepStrictEqual(values, {
			title: "Test Title",
			description: "Test Description",
		});
	});
});
