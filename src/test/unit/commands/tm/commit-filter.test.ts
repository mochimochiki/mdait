import * as assert from "node:assert";
import { isTmCommitTarget } from "../../../../commands/tm/commit-filter";
import { MdaitMarker } from "../../../../core/markdown/mdait-marker";
import { MdaitUnit } from "../../../../core/markdown/mdait-unit";

suite("isTmCommitTarget", () => {
	suite("処理対象の判定（包括方式: from あり ∧ need なしのみ対象）", () => {
		test("from属性あり・need未設定のユニットは処理対象", () => {
			const marker = new MdaitMarker("def456", "abc123", null);
			const unit = new MdaitUnit(marker, "", 0, "Translated content.", 0, 10);
			assert.strictEqual(isTmCommitTarget(unit), true);
		});

		test("from属性なしのユニットはスキップされる（ソース/独立ユニット）", () => {
			const marker = new MdaitMarker("abc123", null, null);
			const unit = new MdaitUnit(marker, "", 0, "Source content.", 0, 10);
			assert.strictEqual(isTmCommitTarget(unit), false);
		});

		test("need:translate付きユニットはスキップされる（未翻訳）", () => {
			const marker = new MdaitMarker("def456", "abc123", "translate");
			const unit = new MdaitUnit(marker, "", 0, "Not yet translated.", 0, 10);
			assert.strictEqual(isTmCommitTarget(unit), false);
		});

		test("need:revise@付きユニットはスキップされる（旧版訳文）", () => {
			const marker = new MdaitMarker("def456", "abc123", "revise@oldHash");
			const unit = new MdaitUnit(marker, "", 0, "Outdated translation.", 0, 10);
			assert.strictEqual(isTmCommitTarget(unit), false);
		});

		test("need:review付きユニットはスキップされる（レビュー待ち）", () => {
			const marker = new MdaitMarker("def456", "abc123", "review");
			const unit = new MdaitUnit(marker, "", 0, "Needs review.", 0, 10);
			assert.strictEqual(isTmCommitTarget(unit), false);
		});

		test("need:isolate付きユニットはスキップされる（孤立ユニット）", () => {
			const marker = new MdaitMarker("def456", "abc123", "isolate");
			const unit = new MdaitUnit(marker, "", 0, "Isolated content.", 0, 10);
			assert.strictEqual(isTmCommitTarget(unit), false);
		});

		test("need:verify-deletion付きユニットはスキップされる（削除確認待ち）", () => {
			const marker = new MdaitMarker("def456", "abc123", "verify-deletion");
			const unit = new MdaitUnit(marker, "", 0, "Pending deletion.", 0, 10);
			assert.strictEqual(isTmCommitTarget(unit), false);
		});

		test("未知のneed値を持つユニットもスキップされる（列挙の穴なし）", () => {
			const marker = new MdaitMarker("def456", "abc123", "custom");
			const unit = new MdaitUnit(marker, "", 0, "Custom need value.", 0, 10);
			assert.strictEqual(isTmCommitTarget(unit), false);
		});
	});
});
