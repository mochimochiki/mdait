import * as assert from "node:assert";
import { buildOtherActions } from "../../../../ui/codelens/codelens-command";
import { shouldShowOtherActions } from "../../../../ui/codelens/codelens-provider";

suite("shouldShowOtherActions（「その他」メニューの表示条件）", () => {
	test("訳文の対訳ユニット（hash と from あり）には表示する", () => {
		assert.strictEqual(shouldShowOtherActions({ hash: "tgtA", from: "srcA" }, false), true);
	});

	test("原文ユニット（hash のみ・from なし）にも表示する", () => {
		assert.strictEqual(shouldShowOtherActions({ hash: "srcA", from: null }, true), true);
	});

	test("from なしの訳文ユニット（独立ユニット）には表示しない", () => {
		assert.strictEqual(shouldShowOtherActions({ hash: "tgtA", from: null }, false), false);
	});

	test("hash が無ければ原文・訳文いずれも表示しない", () => {
		assert.strictEqual(shouldShowOtherActions({ hash: "", from: null }, true), false);
		assert.strictEqual(shouldShowOtherActions({ hash: "", from: "srcA" }, false), false);
	});
});

suite("buildOtherActions（メニュー項目の構成）", () => {
	test("need が無ければ「独立扱いにする」と「ノート」を出す", () => {
		assert.deepStrictEqual(buildOtherActions(false), ["isolate", "note"]);
	});

	test("need があれば isolate は出さない（他の判断待ちを踏み潰さない）", () => {
		assert.deepStrictEqual(buildOtherActions(true), ["note"]);
	});
});
