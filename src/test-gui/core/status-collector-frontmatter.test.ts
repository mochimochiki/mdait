// テストガイドラインに従いテスト実装します。
// StatusCollectorがfrontmatterの翻訳状態を収集することを確認するテスト

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { StatusCollector } from "../../core/status/status-collector";
import { Status } from "../../core/status/status-item";

const TEST_WORKSPACE_PATH = path.resolve(__dirname, "../test/workspace/content");

suite("StatusCollector（frontmatter対応）", () => {
	let tempDir: string;
	let statusCollector: StatusCollector;

	suiteSetup(() => {
		// テスト用ディレクトリを作成
		tempDir = path.join(TEST_WORKSPACE_PATH, "frontmatter-test");
		if (!fs.existsSync(tempDir)) {
			fs.mkdirSync(tempDir, { recursive: true });
		}
		statusCollector = new StatusCollector();
	});

	suiteTeardown(() => {
		// テスト用ファイルを削除
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("frontmatterが未翻訳の場合、ファイルステータスがNeedsTranslationとなること", async () => {
		// テスト用ファイルを作成（frontmatterが未翻訳、本文は翻訳済み）
		const testFile = path.join(tempDir, "needs-translation.md");
		const content = `---
title: Test Title
description: Test Description
mdait.front: abc123 from:def456 need:translate
---

<!-- mdait 111111 from:111111 -->
## Heading 1

Translated content
`;
		fs.writeFileSync(testFile, content, "utf-8");

		const fileStatus = await statusCollector.collectFileStatus(testFile);

		// frontmatterが未翻訳なので、ファイル全体がNeedsTranslation
		assert.strictEqual(
			fileStatus.status,
			Status.NeedsTranslation,
			"frontmatterが未翻訳の場合、ファイルステータスがNeedsTranslationとなること",
		);

		// frontmatter項目が存在すること
		assert.ok(fileStatus.frontmatter, "frontmatter項目が存在すること");
		assert.strictEqual(
			fileStatus.frontmatter?.status,
			Status.NeedsTranslation,
			"frontmatterがNeedsTranslationであること",
		);
	});

	test("frontmatterが翻訳済みで本文も翻訳済みの場合、ファイルステータスがTranslatedとなること", async () => {
		const testFile = path.join(tempDir, "translated.md");
		const content = `---
title: Translated Title
description: Translated Description
mdait.front: abc123 from:def456
---

<!-- mdait 111111 from:111111 -->
## Heading 1

Translated content
`;
		fs.writeFileSync(testFile, content, "utf-8");

		const fileStatus = await statusCollector.collectFileStatus(testFile);

		assert.strictEqual(
			fileStatus.status,
			Status.Translated,
			"frontmatterと本文が翻訳済みの場合、ファイルステータスがTranslatedとなること",
		);

		// frontmatter項目がTranslatedであること
		assert.ok(fileStatus.frontmatter, "frontmatter項目が存在すること");
		assert.strictEqual(fileStatus.frontmatter?.status, Status.Translated, "frontmatterがTranslatedであること");
	});

	test("frontmatterのみのファイルでfrontmatterが未翻訳の場合、ファイルステータスがNeedsTranslationとなること", async () => {
		const testFile = path.join(tempDir, "frontmatter-only-needs.md");
		const content = `---
title: Test Title
description: Test Description
mdait.front: abc123 from:def456 need:translate
---
`;
		fs.writeFileSync(testFile, content, "utf-8");

		const fileStatus = await statusCollector.collectFileStatus(testFile);

		assert.strictEqual(
			fileStatus.status,
			Status.NeedsTranslation,
			"frontmatter-onlyファイルで未翻訳の場合、NeedsTranslationとなること",
		);

		// frontmatter項目が存在し、childrenは空（ユニットなし）
		assert.ok(fileStatus.frontmatter, "frontmatter項目が存在すること");
		assert.strictEqual(fileStatus.children?.length ?? 0, 0, "ユニットは存在しないこと");
	});

	test("Source側ファイル（fromなし）の場合、frontmatterがSourceステータスとなること", async () => {
		const testFile = path.join(tempDir, "source-file.md");
		const content = `---
title: Source Title
description: Source Description
mdait.front: abc123
---

<!-- mdait 111111 -->
## Heading 1

Source content
`;
		fs.writeFileSync(testFile, content, "utf-8");

		const fileStatus = await statusCollector.collectFileStatus(testFile);

		// ソースファイルなのでSourceステータス
		assert.strictEqual(fileStatus.status, Status.Source, "ソースファイルはSourceステータスとなること");

		// frontmatter項目もSource
		assert.ok(fileStatus.frontmatter, "frontmatter項目が存在すること");
		assert.strictEqual(fileStatus.frontmatter?.status, Status.Source, "frontmatterがSourceであること");
	});
});
