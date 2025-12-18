/**
 * @file translation-checker.test.ts
 * @description TranslationCheckerのテスト実装
 * 翻訳品質チェックロジックの検証
 */

import { strict as assert } from "node:assert";
import { TranslationChecker } from "../../../commands/trans/translation-checker";

suite("TranslationChecker", () => {
	const checker = new TranslationChecker();

	suite("checkTranslationQuality", () => {
		test("数値が一致する場合は問題なし", () => {
			const source = "There are 5 items and 10 users.";
			const translation = "5個のアイテムと10人のユーザーがいます。";

			const result = checker.checkTranslationQuality(source, translation);

			assert.strictEqual(result.needsReview, false);
			assert.strictEqual(result.reasons.length, 0);
		});

		test("数値が不一致の場合は確認推奨", () => {
			const source = "There are 5 items.";
			const translation = "3個のアイテムがあります。";

			const result = checker.checkTranslationQuality(source, translation);

			assert.strictEqual(result.needsReview, true);
			assert.strictEqual(result.reasons.length, 1);
			assert.strictEqual(result.reasons[0].category, "number_mismatch");
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
			assert.strictEqual(result.reasons[0].category, "list_count_mismatch");
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
			// 数値(1)の不一致とコードブロックの不一致の2つが検出される可能性があるため、少なくとも1つの理由があることを確認
			assert.ok(result.reasons.length >= 1);
			assert.ok(result.reasons.some((r) => r.category === "code_block_mismatch"));
		});

		test("複数の問題がある場合は全て検出", () => {
			const source = "There are 5 items:\n- Item A\n- Item B\n```code```";
			const translation = "3個のアイテム:\n- アイテムA";

			const result = checker.checkTranslationQuality(source, translation);

			assert.strictEqual(result.needsReview, true);
			// 数値不一致(5 vs 3)、リスト数不一致(2 vs 1)、コードブロック不一致(1 vs 0)の3つ
			assert.strictEqual(result.reasons.length, 3);
			assert.ok(result.reasons.some((r) => r.category === "number_mismatch"));
			assert.ok(result.reasons.some((r) => r.category === "list_count_mismatch"));
			assert.ok(result.reasons.some((r) => r.category === "code_block_mismatch"));
		});

		test("番号付きリストも正しくカウントされる", () => {
			const source = "1. First item\n2. Second item\n3. Third item";
			const translation = "1. 最初の項目\n2. 第二の項目\n3. 第三の項目";

			const result = checker.checkTranslationQuality(source, translation);

			// 数値(1,2,3)が両方にあるので数値の一致は問題なし、リスト数も一致
			assert.strictEqual(result.needsReview, false);
			assert.strictEqual(result.reasons.length, 0);
		});

		test("小数を含む数値も正しく抽出される", () => {
			const source = "The value is 3.14 and 2.5.";
			const translation = "値は3.14と2.5です。";

			const result = checker.checkTranslationQuality(source, translation);

			assert.strictEqual(result.needsReview, false);
			assert.strictEqual(result.reasons.length, 0);
		});
	});
});
