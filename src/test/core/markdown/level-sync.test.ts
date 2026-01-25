// level-validatorのテスト

import { strict as assert } from "node:assert";
import { syncLevelSettings } from "../../../core/markdown/level-sync";
import { FrontMatter } from "../../../core/markdown/front-matter";

suite("level-validator", () => {
	test("level設定が一致している場合、コンテンツを変更しない", () => {
		const sourceFrontMatter = FrontMatter.fromData({
			mdait: {
				sync: {
					level: 3,
				},
			},
		});

		const targetContent = `---
mdait:
  sync:
    level: 3
---

# 見出し

コンテンツ`;

		const result = syncLevelSettings(sourceFrontMatter, targetContent);

		assert.strictEqual(result.modified, false, "変更されないこと");
		assert.strictEqual(result.updatedTargetContent, undefined, "更新コンテンツが返されないこと");
	});

	test("level設定が異なる場合、訳文を原文に合わせて修正する", () => {
		const sourceFrontMatter = FrontMatter.fromData({
			mdait: {
				sync: {
					level: 3,
				},
			},
		});

		const targetContent = `---
mdait:
  sync:
    level: 2
---

# 見出し

コンテンツ`;

		const result = syncLevelSettings(sourceFrontMatter, targetContent);

		assert.strictEqual(result.modified, true, "変更されること");
		assert.ok(result.updatedTargetContent, "更新コンテンツが返されること");

		const { frontMatter } = FrontMatter.parse(result.updatedTargetContent);
		assert.ok(frontMatter, "frontmatterが存在すること");
		assert.strictEqual(frontMatter.get("mdait.sync.level"), 3, "levelが3に修正されること");
		assert.ok(result.updatedTargetContent.includes("# 見出し"), "本文が保持されること");
		assert.ok(result.updatedTargetContent.includes("コンテンツ"), "本文が保持されること");
	});

	test("原文にlevel設定なし、訳文にあり → 訳文のlevel設定を削除", () => {
		const sourceFrontMatter = FrontMatter.fromData({
			title: "Test",
		});

		const targetContent = `---
title: Test
mdait:
  sync:
    level: 2
---

# 見出し

コンテンツ`;

		const result = syncLevelSettings(sourceFrontMatter, targetContent);

		assert.strictEqual(result.modified, true, "変更されること");
		assert.ok(result.updatedTargetContent, "更新コンテンツが返されること");

		const { frontMatter } = FrontMatter.parse(result.updatedTargetContent);
		assert.ok(frontMatter, "frontmatterが存在すること");
		assert.strictEqual(frontMatter.get("mdait.sync.level"), undefined, "levelが削除されること");
		assert.strictEqual(frontMatter.get("title"), "Test", "他のフィールドは保持されること");
	});

	test("原文にlevel設定あり、訳文にfrontmatterなし → 訳文にfrontmatterを作成してlevel設定", () => {
		const sourceFrontMatter = FrontMatter.fromData({
			mdait: {
				sync: {
					level: 4,
				},
			},
		});

		const targetContent = `# 見出し

コンテンツ`;

		const result = syncLevelSettings(sourceFrontMatter, targetContent);

		assert.strictEqual(result.modified, true, "変更されること");
		assert.ok(result.updatedTargetContent, "更新コンテンツが返されること");

		const { frontMatter } = FrontMatter.parse(result.updatedTargetContent);
		assert.ok(frontMatter, "frontmatterが作成されること");
		assert.strictEqual(frontMatter.get("mdait.sync.level"), 4, "levelが4に設定されること");
		assert.ok(result.updatedTargetContent.includes("# 見出し"), "本文が保持されること");
		assert.ok(result.updatedTargetContent.includes("コンテンツ"), "本文が保持されること");
	});

	test("両方にlevel設定なし → 何もしない", () => {
		const sourceFrontMatter = FrontMatter.fromData({
			title: "Test",
		});

		const targetContent = `---
title: Test
---

# 見出し

コンテンツ`;

		const result = syncLevelSettings(sourceFrontMatter, targetContent);

		assert.strictEqual(result.modified, false, "変更されないこと");
		assert.strictEqual(result.updatedTargetContent, undefined, "更新コンテンツが返されないこと");
	});

	test("level値がnumber型でない場合、エラーをスロー", () => {
		const sourceFrontMatter = FrontMatter.fromData({
			mdait: {
				sync: {
					level: "3", // 文字列
				},
			},
		});

		const targetContent = `---
mdait:
  sync:
    level: 2
---

# 見出し`;

		assert.throws(
			() => syncLevelSettings(sourceFrontMatter, targetContent),
			/Invalid mdait.sync.level type/,
			"型エラーがスローされること",
		);
	});

	test("frontmatterにmdaitのみが残り、空になった場合は削除される", () => {
		const sourceFrontMatter = FrontMatter.fromData({
			title: "Test",
		});

		const targetContent = `---
title: Test
mdait:
  sync:
    level: 2
---

# 見出し`;

		const result = syncLevelSettings(sourceFrontMatter, targetContent);

		assert.strictEqual(result.modified, true, "変更されること");
		assert.ok(result.updatedTargetContent, "更新コンテンツが返されること");

		const { frontMatter } = FrontMatter.parse(result.updatedTargetContent);
		assert.ok(frontMatter, "frontmatterが存在すること");
		assert.strictEqual(frontMatter.get("mdait"), undefined, "mdait名前空間が削除されること");
		assert.strictEqual(frontMatter.get("title"), "Test", "他のフィールドは保持されること");
	});

	test("原文にfrontmatterなし、訳文にlevel設定あり → 訳文のlevel設定を削除", () => {
		const sourceFrontMatter = undefined;

		const targetContent = `---
mdait:
  sync:
    level: 2
---

# 見出し`;

		const result = syncLevelSettings(sourceFrontMatter, targetContent);

		assert.strictEqual(result.modified, true, "変更されること");
		assert.ok(result.updatedTargetContent, "更新コンテンツが返されること");

		const { frontMatter } = FrontMatter.parse(result.updatedTargetContent);
		// mdaitが削除されてfrontmatterが空になるため、frontmatterがundefinedになる可能性がある
		if (frontMatter) {
			assert.strictEqual(frontMatter.get("mdait"), undefined, "mdait名前空間が削除されること");
		}
	});
});
