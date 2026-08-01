// 手入力ユーザー向けの案内 CodeLens を出す条件（isManualCompletionNeed）の検証。
// 自分で訳文を書いても need は消えないため、確定ボタンを押す必要があることを
// その場で伝える。ただし裁定待ち（review など）は本文を書く状態ではないので出さない。

import * as assert from "node:assert";
import { isManualCompletionNeed } from "../../../../ui/codelens/codelens-provider";

suite("isManualCompletionNeed（手で訳文を書いて締めくくる状態か）", () => {
	test("未翻訳（translate）は案内の対象", () => {
		assert.strictEqual(isManualCompletionNeed("translate"), true);
	});

	test("原文が変わった（revise@ハッシュ）は案内の対象", () => {
		assert.strictEqual(isManualCompletionNeed("revise@bae62c29"), true);
	});

	test("レビュー待ち・削除確認・独立扱いは本文を書く状態ではないので対象外", () => {
		assert.strictEqual(isManualCompletionNeed("review"), false);
		assert.strictEqual(isManualCompletionNeed("verify-deletion"), false);
		assert.strictEqual(isManualCompletionNeed("isolate"), false);
	});

	test("need が無い（翻訳済み）場合は対象外", () => {
		assert.strictEqual(isManualCompletionNeed(undefined), false);
		assert.strictEqual(isManualCompletionNeed(null), false);
		assert.strictEqual(isManualCompletionNeed(""), false);
	});
});
