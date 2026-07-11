import * as assert from "node:assert";
import {
	classifyTmSkipReason,
	isTmCommitTarget,
	summarizeTmSkipReasons,
} from "../../../../commands/tm/commit-filter";
import { MdaitMarker } from "../../../../core/markdown/mdait-marker";
import { MdaitUnit } from "../../../../core/markdown/mdait-unit";

function unitWith(need: string | null, from: string | null = "src1"): MdaitUnit {
	const marker = new MdaitMarker("hash1", from, need);
	return new MdaitUnit(marker, "", 0, "content", 0, 10);
}

suite("TMスキップ理由の分類（mdait_tm 診断用）", () => {
	suite("classifyTmSkipReason", () => {
		test("登録対象のユニットは null（スキップしない）", () => {
			assert.strictEqual(classifyTmSkipReason(unitWith(null)), null);
		});

		test("from なしは noFrom", () => {
			assert.strictEqual(classifyTmSkipReason(unitWith(null, null)), "noFrom");
		});

		test("need:translate は needTranslate", () => {
			assert.strictEqual(classifyTmSkipReason(unitWith("translate")), "needTranslate");
		});

		test("need:revise@ は needRevise", () => {
			assert.strictEqual(classifyTmSkipReason(unitWith("revise@abc")), "needRevise");
		});

		test("need:review は needReview", () => {
			assert.strictEqual(classifyTmSkipReason(unitWith("review")), "needReview");
		});

		test("need:isolate は needIsolate", () => {
			assert.strictEqual(classifyTmSkipReason(unitWith("isolate")), "needIsolate");
		});

		test("need:verify-deletion は needOther（包括除外）", () => {
			assert.strictEqual(classifyTmSkipReason(unitWith("verify-deletion")), "needOther");
		});

		test("未知の need は needOther（列挙の穴なし）", () => {
			assert.strictEqual(classifyTmSkipReason(unitWith("custom-flag")), "needOther");
		});

		test("sourcePending は target 単体の分類では返さない（commit 側で付与）", () => {
			// need の付いた target はすべて need系理由に分類され、sourcePending にはならない
			for (const need of [null, "translate", "revise@x", "review", "isolate", "verify-deletion", "custom"]) {
				assert.notStrictEqual(classifyTmSkipReason(unitWith(need)), "sourcePending");
			}
		});

		test("分類は isTmCommitTarget と整合する（null ⇔ 登録対象）", () => {
			const cases: Array<[string | null, string | null]> = [
				[null, "src1"],
				["translate", "src1"],
				["revise@x", "src1"],
				["review", "src1"],
				["isolate", "src1"],
				["isolate", null],
				["verify-deletion", "src1"],
				["custom", "src1"],
				[null, null],
			];
			for (const [need, from] of cases) {
				const unit = unitWith(need, from);
				const reason = classifyTmSkipReason(unit);
				assert.strictEqual(
					reason === null,
					isTmCommitTarget(unit),
					`need=${need} from=${from} で分類と対象判定が不整合`,
				);
			}
		});
	});

	suite("summarizeTmSkipReasons", () => {
		test("理由別に正しく集計される", () => {
			const breakdown = summarizeTmSkipReasons([
				unitWith(null),
				unitWith("translate"),
				unitWith("translate"),
				unitWith("revise@x"),
				unitWith("review"),
				unitWith("isolate"),
				unitWith("verify-deletion"),
				unitWith("isolate", null),
				unitWith(null, null),
			]);
			assert.deepStrictEqual(breakdown, {
				noFrom: 2, // fromなし + isolate(fromなし)はnoFrom判定が先
				needTranslate: 2,
				needRevise: 1,
				needReview: 1,
				needIsolate: 1,
				needOther: 1,
				sourcePending: 0,
			});
		});

		test("from付きのneed:isolateはneedIsolateに分類される", () => {
			const breakdown = summarizeTmSkipReasons([unitWith("isolate", "src1")]);
			assert.strictEqual(breakdown.needIsolate, 1);
		});
	});
});
