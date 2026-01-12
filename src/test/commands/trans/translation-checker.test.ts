/**
 * @file translation-checker.test.ts
 * @description TranslationCheckerのテスト実装
 * markdown-itベースの構造比較による翻訳品質チェックロジックの検証
 */

import { strict as assert } from "node:assert";
import { TranslationChecker } from "../../../commands/trans/translation-checker";

suite("TranslationChecker", () => {
	const checker = new TranslationChecker();

	suite("checkTranslationQuality", () => {
		test("完全一致する構造は問題なし", () => {
			const source = "# Title\n\nText with **bold**.\n\n- Item 1\n- Item 2\n\n```js\ncode\n```";
			const translation = "# タイトル\n\n**太字**のテキスト。\n\n- 項目1\n- 項目2\n\n```js\ncode\n```";

			const result = checker.checkTranslationQuality(source, translation);

			assert.strictEqual(result.needsReview, false);
			assert.strictEqual(result.reasons.length, 0);
		});

		test("見出しレベルが不一致の場合は確認推奨", () => {
			const source = "# Title\n\n## Subtitle";
			const translation = "# タイトル\n\n### サブタイトル";

			const result = checker.checkTranslationQuality(source, translation);

			assert.strictEqual(result.needsReview, true);
			assert.ok(result.reasons.some((r) => r.category === "heading_mismatch"));
			assert.ok(result.reasons.some((r) => r.message.includes("見出しレベル2")));
			assert.ok(result.reasons.some((r) => r.message.includes("見出しレベル3")));
		});

		test("見出し数が不一致の場合は確認推奨", () => {
			const source = "# Title\n\n## Section 1\n\n## Section 2";
			const translation = "# タイトル\n\n## セクション1";

			const result = checker.checkTranslationQuality(source, translation);

			assert.strictEqual(result.needsReview, true);
			assert.ok(result.reasons.some((r) => r.category === "heading_mismatch"));
			assert.ok(result.reasons.some((r) => r.message.includes("見出しレベル2")));
		});

		test("リスト項目数が一致する場合は問題なし", () => {
			const source = "- Item 1\n- Item 2\n- Item 3";
			const translation = "- アイテム1\n- アイテム2\n- アイテム3";

			const result = checker.checkTranslationQuality(source, translation);

			assert.strictEqual(result.needsReview, false);
			assert.strictEqual(result.reasons.length, 0);
		});

		test("リスト項目数が不一致の場合は確認推奨", () => {
			const source = "- Item A\n- Item B\n- Item C";
			const translation = "- アイテムA\n- アイテムB";

			const result = checker.checkTranslationQuality(source, translation);

			assert.strictEqual(result.needsReview, true);
			assert.strictEqual(result.reasons.length, 1);
			assert.strictEqual(result.reasons[0].category, "list_mismatch");
			assert.ok(result.reasons[0].message.includes("3項目"));
			assert.ok(result.reasons[0].message.includes("2項目"));
		});

		test("コードブロック数が一致する場合は問題なし", () => {
			const source = "Here is code:\n```js\nconst x = 1;\n```\nAnd more:\n```python\ny = 2\n```";
			const translation = "コードです:\n```js\nconst x = 1;\n```\nさらに:\n```python\ny = 2\n```";

			const result = checker.checkTranslationQuality(source, translation);

			assert.strictEqual(result.needsReview, false);
			assert.strictEqual(result.reasons.length, 0);
		});

		test("コードブロック数が不一致の場合は確認推奨", () => {
			const source = "Here is code:\n```js\nconst x = y;\n```";
			const translation = "コードです。";

			const result = checker.checkTranslationQuality(source, translation);

			assert.strictEqual(result.needsReview, true);
			assert.ok(result.reasons.some((r) => r.category === "code_block_mismatch"));
			assert.ok(result.reasons.some((r) => r.message.includes("1個")));
			assert.ok(result.reasons.some((r) => r.message.includes("0個")));
		});

		test("引用ブロック数が不一致の場合は確認推奨", () => {
			const source = "> Quote 1\n\n> Quote 2";
			const translation = "> 引用1";

			const result = checker.checkTranslationQuality(source, translation);

			assert.strictEqual(result.needsReview, true);
			assert.ok(result.reasons.some((r) => r.category === "blockquote_mismatch"));
		});

		test("テーブル数が不一致の場合は確認推奨", () => {
			const source = "| A | B |\n|---|---|\n| 1 | 2 |";
			const translation = "データなし";

			const result = checker.checkTranslationQuality(source, translation);

			assert.strictEqual(result.needsReview, true);
			assert.ok(result.reasons.some((r) => r.category === "table_mismatch"));
		});

		test("リンク数が不一致の場合は確認推奨", () => {
			const source = "See [link1](url1) and [link2](url2)";
			const translation = "[リンク1](url1)を参照";

			const result = checker.checkTranslationQuality(source, translation);

			assert.strictEqual(result.needsReview, true);
			assert.ok(result.reasons.some((r) => r.category === "link_mismatch"));
		});

		test("画像数が不一致の場合は確認推奨", () => {
			const source = "![alt1](img1.png) and ![alt2](img2.png)";
			const translation = "![代替1](img1.png)";

			const result = checker.checkTranslationQuality(source, translation);

			assert.strictEqual(result.needsReview, true);
			assert.ok(result.reasons.some((r) => r.category === "image_mismatch"));
		});

		test("複数の問題がある場合は全て検出", () => {
			const source = "# Title\n\n- Item A\n- Item B\n\n```\ncode\n```\n\n[link](url)";
			const translation = "## タイトル\n\n- アイテムA";

			const result = checker.checkTranslationQuality(source, translation);

			assert.strictEqual(result.needsReview, true);
			// 見出しレベル不一致(H1->0, H2->1の2つ)、リスト数不一致(2->1)、コードブロック不一致(1->0)、リンク不一致(1->0)
			// = 合計5つの不一致
			assert.ok(result.reasons.length >= 5, `Expected at least 5 reasons, got ${result.reasons.length}`);
			assert.ok(
				result.reasons.some((r) => r.category === "heading_mismatch"),
				"Should detect heading mismatch",
			);
			assert.ok(
				result.reasons.some((r) => r.category === "list_mismatch"),
				"Should detect list mismatch",
			);
			assert.ok(
				result.reasons.some((r) => r.category === "code_block_mismatch"),
				"Should detect code block mismatch",
			);
			assert.ok(
				result.reasons.some((r) => r.category === "link_mismatch"),
				"Should detect link mismatch",
			);
		});

		test("番号付きリストも正しくカウントされる", () => {
			const source = "1. First item\n2. Second item\n3. Third item";
			const translation = "1. 最初の項目\n2. 第二の項目\n3. 第三の項目";

			const result = checker.checkTranslationQuality(source, translation);

			assert.strictEqual(result.needsReview, false);
			assert.strictEqual(result.reasons.length, 0);
		});

		test("ネストされたリストも正しくカウントされる", () => {
			const source = "- Item 1\n  - Nested 1\n  - Nested 2\n- Item 2";
			const translation = "- 項目1\n  - ネスト1\n  - ネスト2\n- 項目2";

			const result = checker.checkTranslationQuality(source, translation);

			assert.strictEqual(result.needsReview, false);
			assert.strictEqual(result.reasons.length, 0);
		});
	});
});
