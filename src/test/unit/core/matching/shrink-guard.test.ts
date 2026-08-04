// 「数が急に減った」ことを一時的な崩れとして疑うかどうかの判定。
// unit-state の行を刈るかどうかと、訳文ユニットを自動削除するかどうかの**両方**がこれに従う。
// 述語は1つだが、判断を誤ったときの代償が違うので慎重さの度合いは用途で変える。

import { strict as assert } from "node:assert";
import {
	DELETE_SUSPICION,
	PRUNE_SUSPICION,
	isSuspiciousShrink,
} from "../../../../core/matching/shrink-guard";

suite("isSuspiciousShrink（刈り取り側の慎重さ）", () => {
	const suspicious = (before: number, after: number) => isSuspiciousShrink(before, after, PRUNE_SUSPICION);

	test("減っていなければ疑わないこと", () => {
		assert.strictEqual(suspicious(5, 5), false);
		assert.strictEqual(suspicious(5, 8), false);
	});

	test("減少幅が下限に届かなければ疑わないこと", () => {
		assert.strictEqual(suspicious(4, 2), false, "減少2件は普通の編集として扱う");
		assert.strictEqual(suspicious(2, 1), false, "比率では半減だが件数が小さい");
	});

	test("半分以上残っていれば疑わないこと", () => {
		assert.strictEqual(suspicious(10, 6), false);
		assert.strictEqual(suspicious(8, 4), false, "ちょうど半分は疑わない");
	});

	test("半分未満へ下限以上減ったら疑うこと", () => {
		assert.strictEqual(suspicious(6, 1), true);
		assert.strictEqual(suspicious(20, 1), true);
		assert.strictEqual(suspicious(7, 3), true);
	});

	test("既定の設定は刈り取り側であること（呼び出し側の取り違えを防ぐ）", () => {
		assert.strictEqual(isSuspiciousShrink(4, 2), suspicious(4, 2));
		assert.strictEqual(isSuspiciousShrink(3, 1), suspicious(3, 1));
	});
});

suite("isSuspiciousShrink（自動削除側の慎重さ）", () => {
	const suspicious = (before: number, after: number) => isSuspiciousShrink(before, after, DELETE_SUSPICION);

	test("対応が1件以下しか残らなければ、減少幅が1件でも疑うこと", () => {
		// パースが崩れると文書は大きさに関係なく1ユニットまで潰れる。
		// 刈り取り側の下限（3件）をそのまま使うと、小さい文書で訳文が物理削除されていた
		assert.strictEqual(suspicious(2, 1), true, "見出し1つの文書");
		assert.strictEqual(suspicious(3, 1), true, "見出し2つの README");
		assert.strictEqual(suspicious(4, 1), true);
	});

	test("全部の対応が失われるのは最も疑わしいこと", () => {
		assert.strictEqual(suspicious(1, 0), true);
		assert.strictEqual(suspicious(2, 0), true);
		assert.strictEqual(suspicious(8, 0), true);
	});

	test("十分に残っていれば普通の削除として扱うこと", () => {
		assert.strictEqual(suspicious(8, 7), false, "1章だけ消した");
		assert.strictEqual(suspicious(3, 2), false, "3章のうち1章を消した");
		assert.strictEqual(suspicious(10, 6), false);
		assert.strictEqual(suspicious(8, 4), false, "ちょうど半分は疑わない");
	});

	test("半分未満へまとめて減ったときも疑うこと（章をごっそり落とす改稿）", () => {
		assert.strictEqual(suspicious(8, 3), true);
		assert.strictEqual(suspicious(20, 2), true);
	});

	test("減っていなければ疑わないこと", () => {
		assert.strictEqual(suspicious(5, 5), false);
		assert.strictEqual(suspicious(0, 0), false);
	});

	test("刈り取り側より広く疑うこと（代償が非対称なので慎重さが違う）", () => {
		// 削除側だけが疑う組（＝小さい文書が1ユニットまで潰れた形）。
		// 4→1 は比率と減少幅で刈り取り側も疑うし、残り0は刈り取り側の設定でも疑うので、ここには入れない
		for (const [before, after] of [
			[2, 1],
			[3, 1],
		]) {
			assert.strictEqual(isSuspiciousShrink(before, after, PRUNE_SUSPICION), false, `prune ${before}->${after}`);
			assert.strictEqual(isSuspiciousShrink(before, after, DELETE_SUSPICION), true, `delete ${before}->${after}`);
		}
	});
});
