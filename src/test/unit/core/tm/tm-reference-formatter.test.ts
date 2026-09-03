/**
 * @file tm-references.test.ts
 * @description trans-commandのTM参照フォーマット関数のテスト
 */

import { strict as assert } from "node:assert";
import { formatTmReferences } from "../../../../core/tm/tm-reference-formatter";
import type { TmMatch } from "../../../../core/tm/types";

suite("formatTmReferences", () => {
	test("単一のTM参照をフォーマットできる", () => {
		const matches: TmMatch[] = [
			{
				sentenceHash: "a1b2c3d4",
				source: "Download the installer",
				target: "インストーラーをダウンロード",
				firstUsedIn: "docs/guide.md",
			},
		];

		const result = formatTmReferences(matches);

		assert.ok(result.includes('1. Source: "Download the installer"'));
		assert.ok(result.includes('Translation: "インストーラーをダウンロード"'));
		assert.ok(result.includes("(from: docs/guide.md)"));
	});

	test("複数のTM参照を番号付きでフォーマットできる", () => {
		const matches: TmMatch[] = [
			{
				sentenceHash: "a1b2c3d4",
				source: "Download the installer",
				target: "インストーラーをダウンロード",
				firstUsedIn: "docs/guide.md",
			},
			{
				sentenceHash: "e5f6g7h8",
				source: "Run the installer",
				target: "インストーラーを実行",
				firstUsedIn: "docs/api.md",
			},
		];

		const result = formatTmReferences(matches);

		assert.ok(result.includes("1. Source:"));
		assert.ok(result.includes("2. Source:"));
		assert.ok(result.includes("(from: docs/guide.md)"));
		assert.ok(result.includes("(from: docs/api.md)"));
	});

	test("firstUsedInが空文字の場合はfrom情報を含まない", () => {
		const matches: TmMatch[] = [
			{
				sentenceHash: "a1b2c3d4",
				source: "Hello",
				target: "こんにちは",
				firstUsedIn: "",
			},
		];

		const result = formatTmReferences(matches);

		assert.ok(result.includes('1. Source: "Hello"'));
		assert.ok(result.includes('Translation: "こんにちは"'));
		assert.ok(!result.includes("(from:"));
	});

	test("空配列の場合は空文字列を返す", () => {
		const result = formatTmReferences([]);
		assert.strictEqual(result, "");
	});
});
