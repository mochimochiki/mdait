// 独立ユニット（原文と結びついていない訳文の章）の判定。
//
// 背景: 画面では「独立」「凍結」「孤立」が似て見える。実体は別物で、混ぜると
// 「原文なし」と出すべきでない章に出てしまう（原文ユニットは from を持たないので、
// マーカーだけを見ると独立ユニットと同じ形をしている）。ここはその境目の番人である。

import * as assert from "node:assert";
import { isIndependentUnit } from "../../../../core/unit-state/independent-unit";

const TARGET = false;
const SOURCE = true;

suite("isIndependentUnit（独立ユニットの判定）", () => {
	test("訳文の from なし・need なしのユニットは独立ユニット", () => {
		assert.strictEqual(isIndependentUnit({ hash: "aaaa", from: null, need: null }, TARGET), true);
	});

	test("原文ファイルのユニットは from が無くても独立ユニットではない", () => {
		assert.strictEqual(isIndependentUnit({ hash: "aaaa", from: null, need: null }, SOURCE), false);
	});

	test("from があれば独立ユニットではない（原文と結びついている）", () => {
		assert.strictEqual(isIndependentUnit({ hash: "aaaa", from: "bbbb", need: null }, TARGET), false);
	});

	test("凍結（need:isolate）は独立ユニットではない — 原文は在って、更新を流さないだけ", () => {
		assert.strictEqual(isIndependentUnit({ hash: "aaaa", from: "bbbb", need: "isolate" }, TARGET), false);
	});

	test("裁定待ちの章は from が無くても独立ユニットとしない（裁定のほうを先に伝える）", () => {
		assert.strictEqual(isIndependentUnit({ hash: "aaaa", from: null, need: "review" }, TARGET), false);
		assert.strictEqual(isIndependentUnit({ hash: "aaaa", from: null, need: "verify-deletion" }, TARGET), false);
	});

	test("マーカーが無い（hash 空・未登録）章は独立ユニットではない", () => {
		assert.strictEqual(isIndependentUnit({ hash: "", from: null, need: null }, TARGET), false);
		assert.strictEqual(isIndependentUnit(null, TARGET), false);
		assert.strictEqual(isIndependentUnit(undefined, TARGET), false);
	});
});
