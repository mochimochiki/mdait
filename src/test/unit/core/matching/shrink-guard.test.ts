// 「数が急に減った」ことを一時的な崩れとして疑うかどうかの判定。
// unit-state の行を刈るかどうかと、訳文ユニットを自動削除するかどうかの**両方**がこれに従う。

import { strict as assert } from "node:assert";
import { MIN_SUSPICIOUS_DROP, isSuspiciousShrink } from "../../../../core/matching/shrink-guard";

suite("isSuspiciousShrink（一時的な崩れを疑う判定）", () => {
	test("減っていなければ疑わないこと", () => {
		assert.strictEqual(isSuspiciousShrink(5, 5), false);
		assert.strictEqual(isSuspiciousShrink(5, 8), false);
	});

	test("減少幅が下限に届かなければ疑わないこと", () => {
		assert.strictEqual(isSuspiciousShrink(4, 2), false, "減少2件は普通の編集として扱う");
		assert.strictEqual(isSuspiciousShrink(2, 1), false, "比率では半減だが件数が小さい");
	});

	test("半分以上残っていれば疑わないこと", () => {
		assert.strictEqual(isSuspiciousShrink(10, 6), false);
		assert.strictEqual(isSuspiciousShrink(8, 4), false, "ちょうど半分は疑わない");
	});

	test("半分未満へ下限以上減ったら疑うこと", () => {
		assert.strictEqual(isSuspiciousShrink(6, 1), true);
		assert.strictEqual(isSuspiciousShrink(20, 1), true);
		assert.strictEqual(isSuspiciousShrink(7, 3), true);
	});

	test("全部無くなるのは最も疑わしいと扱うこと", () => {
		// 孤立ユニットの自動削除では「対応が1つも残らない」が最悪ケースになる。
		// ここで false を返すと、原文が丸ごとパースできないときに訳文が全部消える
		assert.strictEqual(isSuspiciousShrink(MIN_SUSPICIOUS_DROP, 0), true);
		assert.strictEqual(isSuspiciousShrink(8, 0), true);
	});

	test("下限ちょうどの境界", () => {
		assert.strictEqual(isSuspiciousShrink(MIN_SUSPICIOUS_DROP - 1, 0), false);
	});
});
