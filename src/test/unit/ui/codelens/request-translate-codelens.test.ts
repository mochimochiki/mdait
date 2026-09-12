// review 行の CodeLens に「翻訳待ちに戻す」（need:review → need:translate）が出ること、
// 裁定待ちの行に「Next」が出ないことの検証。
// ボタンの並びは buildUnitCodeLensSpecs（純関数）が決めるので、vscode の型に触れずに検査できる。

import * as assert from "node:assert";
import { MdaitMarker } from "../../../../core/markdown/mdait-marker";
import {
	REQUEST_TRANSLATE_COMMAND,
	buildUnitCodeLensSpecs,
	shouldOfferRequestTranslate,
} from "../../../../ui/codelens/codelens-provider";

/** マーカー行の文字列から MdaitMarker を作る（parse できなければテストの書き間違い） */
function marker(line: string): MdaitMarker {
	const parsed = MdaitMarker.parse(line);
	assert.ok(parsed, `マーカーとして読めない: ${line}`);
	return parsed;
}

suite("shouldOfferRequestTranslate（「翻訳待ちに戻す」の表示条件）", () => {
	test("訳文の need:review には出す", () => {
		assert.strictEqual(shouldOfferRequestTranslate({ need: "review" }, false), true);
	});

	test("原文側には出さない（訳し直すものが無い）", () => {
		assert.strictEqual(shouldOfferRequestTranslate({ need: "review" }, true), false);
	});

	test("review 以外の need と need なしには出さない", () => {
		for (const need of [null, "translate", "revise@old", "verify-deletion", "isolate"]) {
			assert.strictEqual(shouldOfferRequestTranslate({ need }, false), false, `need=${need}`);
		}
	});
});

suite("buildUnitCodeLensSpecs（review 行のボタン構成）", () => {
	test("訳文の review 行は Source → Mark as Reviewed → Mark as Needs Translation → More の順", () => {
		const specs = buildUnitCodeLensSpecs(marker("<!-- mdait tgtA from:srcA need:review -->"), false);

		assert.deepStrictEqual(
			specs.map((s) => s.command),
			[
				"mdait.codelens.jumpToSource",
				"mdait.codelens.clearNeed",
				REQUEST_TRANSLATE_COMMAND,
				"mdait.codelens.otherActions",
			],
		);
	});

	test("「翻訳待ちに戻す」は完了ボタンの直後に置かれ、AI を呼ばないので ✨ が付かない", () => {
		const specs = buildUnitCodeLensSpecs(marker("<!-- mdait tgtA from:srcA need:review -->"), false);

		const completeAt = specs.findIndex((s) => s.command === "mdait.codelens.clearNeed");
		const requestAt = specs.findIndex((s) => s.command === REQUEST_TRANSLATE_COMMAND);
		assert.ok(completeAt >= 0, "完了ボタンが出ること");
		assert.strictEqual(requestAt, completeAt + 1, "完了ボタンの直後に出ること");
		assert.strictEqual(specs[requestAt].title, "$(discard) Mark as Needs Translation");
		assert.ok(!specs[requestAt].title.includes("✨"), "AI を呼ばない操作に ✨ を付けない");
		assert.ok(!specs[requestAt].title.includes("$(sparkle)"), "AI を呼ばない操作に ✨ を付けない");
	});

	test("原文側の review 行には「翻訳待ちに戻す」を出さない", () => {
		const specs = buildUnitCodeLensSpecs(marker("<!-- mdait srcA need:review -->"), true);

		assert.ok(!specs.some((s) => s.command === REQUEST_TRANSLATE_COMMAND));
	});

	test("review 以外の need の行には「翻訳待ちに戻す」を出さない", () => {
		for (const line of [
			"<!-- mdait tgtA from:srcA -->",
			"<!-- mdait tgtA from:srcA need:translate -->",
			"<!-- mdait tgtA from:srcA need:revise@old -->",
			"<!-- mdait tgtA from:srcA need:verify-deletion -->",
			"<!-- mdait tgtA from:srcA need:isolate -->",
		]) {
			const specs = buildUnitCodeLensSpecs(marker(line), false);
			assert.ok(!specs.some((s) => s.command === REQUEST_TRANSLATE_COMMAND), line);
		}
	});
});

suite("buildUnitCodeLensSpecs（「Next」は CodeLens に出さない）", () => {
	test("review 行に mdait.needsAttention.next のボタンは無い", () => {
		const specs = buildUnitCodeLensSpecs(marker("<!-- mdait tgtA from:srcA need:review -->"), false);

		assert.ok(!specs.some((s) => s.command === "mdait.needsAttention.next"));
		assert.ok(!specs.some((s) => s.title.includes("Next")));
	});

	test("verify-deletion 行は Source → Keep → Delete Unit → More で、Next は無い", () => {
		const specs = buildUnitCodeLensSpecs(marker("<!-- mdait tgtA from:srcA need:verify-deletion -->"), false);

		assert.deepStrictEqual(
			specs.map((s) => s.command),
			[
				"mdait.codelens.jumpToSource",
				"mdait.codelens.keepUnit",
				"mdait.codelens.deleteUnit",
				"mdait.codelens.otherActions",
			],
		);
	});
});
