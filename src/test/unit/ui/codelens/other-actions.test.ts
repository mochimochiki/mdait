import * as assert from "node:assert";
import { buildOtherActions, canRetranslateInFull } from "../../../../ui/codelens/codelens-command";
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

suite("canRetranslateInFull（全文で訳し直せるユニットか）", () => {
	test("訳し終えた訳文（need 空）は訳し直せる — 訳が古びたときの素の要求", () => {
		assert.strictEqual(canRetranslateInFull({ from: "srcA", need: null }, false), true);
	});

	test("原文が変わった訳文（revise@）は訳し直せる — 据え置かれたときの抜け道", () => {
		assert.strictEqual(canRetranslateInFull({ from: "srcA", need: "revise@srcOld" }, false), true);
	});

	test("まだ訳していない訳文には出さない（✨翻訳がそのまま全文翻訳なので重複する）", () => {
		assert.strictEqual(canRetranslateInFull({ from: "srcA", need: "translate" }, false), false);
	});

	test("確認待ちの既訳には出さない（AI の上書きから守るための状態である）", () => {
		assert.strictEqual(canRetranslateInFull({ from: "srcA", need: "review" }, false), false);
	});

	test("判断待ち・凍結宣言には出さない", () => {
		assert.strictEqual(canRetranslateInFull({ from: "srcA", need: "verify-deletion" }, false), false);
		assert.strictEqual(canRetranslateInFull({ from: "srcA", need: "isolate" }, false), false);
	});

	test("原文側と、原文に結びついていない訳文には出さない", () => {
		assert.strictEqual(canRetranslateInFull({ from: null, need: null }, true), false);
		assert.strictEqual(canRetranslateInFull({ from: null, need: null }, false), false);
	});
});

suite("buildOtherActions（訳し直しを含む構成）", () => {
	test("訳し終えた訳文では 独立扱い → 訳し直す → ノート の順に並ぶ", () => {
		assert.deepStrictEqual(buildOtherActions(false, true), ["isolate", "retranslate", "note"]);
	});

	test("need がある訳文（revise）では isolate を外し、訳し直しは残す", () => {
		assert.deepStrictEqual(buildOtherActions(true, true), ["retranslate", "note"]);
	});

	test("訳し直せないユニットでは従来どおりの構成に戻る", () => {
		assert.deepStrictEqual(buildOtherActions(false, false), ["isolate", "note"]);
		assert.deepStrictEqual(buildOtherActions(true, false), ["note"]);
	});
});
