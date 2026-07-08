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

		test("need:keep は needKeep", () => {
			assert.strictEqual(classifyTmSkipReason(unitWith("keep")), "needKeep");
		});

		test("分類は isTmCommitTarget と整合する（null ⇔ 登録対象）", () => {
			const cases: Array<[string | null, string | null]> = [
				[null, "src1"],
				["translate", "src1"],
				["revise@x", "src1"],
				["review", "src1"],
				["keep", null],
				["verify-deletion", "src1"],
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
				unitWith("keep", null),
				unitWith(null, null),
			]);
			assert.deepStrictEqual(breakdown, {
				noFrom: 2, // fromなし + keep(fromなし)はnoFrom判定が先
				needTranslate: 2,
				needRevise: 1,
				needReview: 1,
				needKeep: 0,
			});
		});

		test("from付きのneed:keepはneedKeepに分類される", () => {
			const breakdown = summarizeTmSkipReasons([unitWith("keep", "src1")]);
			assert.strictEqual(breakdown.needKeep, 1);
		});
	});
});
