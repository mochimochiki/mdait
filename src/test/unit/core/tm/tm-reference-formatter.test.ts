/**
 * @file tm-reference-formatter.test.ts
 * @description TM参照のフォーマットのテスト
 *
 * 各件の先頭に「いま訳している文にどれだけ近いか」を付ける。付けないと受け取る側は
 * 完全一致と遠い参考を区別できない（実測: 区別が無いまま渡すと近似一致の採用が
 * 回ごとに揺れた）。100% と読めるのは本当に完全一致のときだけにする。
 */

import { strict as assert } from "node:assert";
import { formatTmReferences } from "../../../../core/tm/tm-reference-formatter";
import type { TmMatch } from "../../../../core/tm/types";

/** 試験用の1件を作る */
function match(overrides: Partial<TmMatch> = {}): TmMatch {
	return {
		sentenceHash: "a1b2c3d4",
		source: "Download the installer",
		target: "インストーラーをダウンロード",
		firstUsedIn: "docs/guide.md",
		similarity: 1,
		...overrides,
	};
}

suite("formatTmReferences", () => {
	test("単一のTM参照をフォーマットできる", () => {
		const result = formatTmReferences([match()]);

		assert.ok(result.includes('Source: "Download the installer"'));
		assert.ok(result.includes('Translation: "インストーラーをダウンロード"'));
		assert.ok(result.includes("(from: docs/guide.md)"));
	});

	test("複数のTM参照を番号付きでフォーマットできる", () => {
		const result = formatTmReferences([
			match(),
			match({ sentenceHash: "e5f6g7h8", source: "Run the installer", firstUsedIn: "docs/api.md" }),
		]);

		assert.ok(result.includes("1. "));
		assert.ok(result.includes("2. "));
		assert.ok(result.includes("(from: docs/guide.md)"));
		assert.ok(result.includes("(from: docs/api.md)"));
	});

	test("firstUsedInが空文字の場合はfrom情報を含まない", () => {
		const result = formatTmReferences([match({ firstUsedIn: "" })]);

		assert.ok(result.includes('Source: "Download the installer"'));
		assert.ok(!result.includes("(from:"));
	});

	test("空配列の場合は空文字列を返す", () => {
		assert.strictEqual(formatTmReferences([]), "");
	});

	suite("一致度を先頭に付ける", () => {
		test("完全一致は 100% と出る", () => {
			assert.ok(formatTmReferences([match({ similarity: 1 })]).includes("1. [100% match] Source:"));
		});

		test("完全一致でなければ 100% にはならない", () => {
			// 四捨五入すると 100% になる値。受け取る側が「同じ文だ」と読み違えるので切り捨てる
			assert.ok(formatTmReferences([match({ similarity: 0.996 })]).includes("[99% match]"));
			assert.ok(formatTmReferences([match({ similarity: 0.999 })]).includes("[99% match]"));
		});

		test("途中の値はそのまま百分率になる", () => {
			assert.ok(formatTmReferences([match({ similarity: 0.42 })]).includes("[42% match]"));
			assert.ok(formatTmReferences([match({ similarity: 0.155 })]).includes("[15% match]"));
		});

		test("壊れた値でも 0〜100 に収まり、数にならない値は弱いほうへ倒れる", () => {
			// NaN と Infinity は「計算が壊れた」合図なので 0% にする。100% に倒すと、
			// 壊れたときにいちばん強い合図（同じ文だ）が出てしまう。
			for (const [similarity, expected] of [
				[Number.NaN, 0],
				[Number.POSITIVE_INFINITY, 0],
				[Number.NEGATIVE_INFINITY, 0],
				[-1, 0],
				[0, 0],
				[1.5, 100],
			] as const) {
				assert.ok(
					formatTmReferences([match({ similarity })]).includes(`[${expected}% match]`),
					`similarity=${similarity} は ${expected}% になること`,
				);
			}
		});

		test("件ごとに違う一致度が出る", () => {
			const result = formatTmReferences([match({ similarity: 1 }), match({ similarity: 0.3 })]);

			assert.ok(result.includes("1. [100% match]"));
			assert.ok(result.includes("2. [30% match]"));
		});
	});
});
