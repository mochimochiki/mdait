import * as assert from "node:assert";
import { Status, StatusItemType } from "../../../core/status/status-item";
import type { FileStatusItem, UnitStatusItem } from "../../../core/status/status-item";
import { buildStatusData, countNeeds, totalActionableNeeds } from "../../../lm-tools/status-data";

function unit(overrides: Partial<UnitStatusItem>): UnitStatusItem {
	return {
		type: StatusItemType.Unit,
		label: "unit",
		status: Status.NeedsTranslation,
		filePath: "/ws/docs/en/a.md",
		unitHash: "hash",
		...overrides,
	};
}

function file(filePath: string, units: UnitStatusItem[], status = Status.NeedsTranslation): FileStatusItem {
	return {
		type: StatusItemType.File,
		label: filePath,
		status,
		filePath,
		fileName: filePath.split("/").pop() ?? filePath,
		totalUnits: units.length,
		translatedUnits: units.filter((u) => u.status === Status.Translated).length,
		children: units,
	};
}

suite("status-data（need内訳集計）", () => {
	suite("countNeeds", () => {
		test("need語彙ごとに分類して集計する", () => {
			const needs = countNeeds([
				unit({ needFlag: "translate" }),
				unit({ needFlag: "translate" }),
				unit({ needFlag: "revise@abc123" }),
				unit({ needFlag: "review" }),
				unit({ needFlag: "verify-deletion" }),
				unit({ needFlag: "keep" }),
				unit({ needFlag: "backfill" }),
				unit({ needFlag: "custom-flag" }),
				unit({ needFlag: undefined, status: Status.Translated }),
			]);
			assert.strictEqual(needs.translate, 2);
			assert.strictEqual(needs.revise, 1);
			assert.strictEqual(needs.review, 1);
			assert.strictEqual(needs.verifyDeletion, 1);
			assert.strictEqual(needs.keep, 1);
			assert.strictEqual(needs.backfill, 1);
			assert.strictEqual(needs.other, 1);
		});

		test("reviewはreviseに誤分類されない", () => {
			const needs = countNeeds([unit({ needFlag: "review" })]);
			assert.strictEqual(needs.revise, 0);
			assert.strictEqual(needs.review, 1);
		});

		test("ソースユニットは集計対象外", () => {
			const needs = countNeeds([unit({ needFlag: "translate", status: Status.Source })]);
			assert.strictEqual(needs.translate, 0);
		});
	});

	suite("totalActionableNeeds", () => {
		test("keepは実作業対象に含めない", () => {
			const needs = countNeeds([unit({ needFlag: "keep" }), unit({ needFlag: "translate" })]);
			assert.strictEqual(totalActionableNeeds(needs), 1);
		});
	});

	suite("buildStatusData", () => {
		test("全体集計とファイル数の内訳を返す", () => {
			const files = [
				file("/ws/docs/en/a.md", [
					unit({ needFlag: "translate" }),
					unit({ status: Status.Translated }),
				]),
				file(
					"/ws/docs/en/b.md",
					[unit({ status: Status.Translated }), unit({ status: Status.Translated })],
					Status.Translated,
				),
			];
			const data = buildStatusData(files, false);
			assert.strictEqual(data.totalUnits, 4);
			assert.strictEqual(data.translatedUnits, 3);
			assert.strictEqual(data.needs.translate, 1);
			assert.strictEqual(data.filesWithNeeds, 1);
			assert.strictEqual(data.filesTranslated, 1);
			assert.strictEqual(data.files, undefined);
		});

		test("detail:trueでneedのあるファイルのみ内訳一覧を返す", () => {
			const files = [
				file("/ws/docs/en/a.md", [unit({ needFlag: "translate" })]),
				file("/ws/docs/en/b.md", [unit({ status: Status.Translated })], Status.Translated),
			];
			const data = buildStatusData(files, true);
			assert.ok(data.files);
			assert.strictEqual(data.files.length, 1);
			assert.strictEqual(data.files[0].path, "/ws/docs/en/a.md");
			assert.strictEqual(data.files[0].needs.translate, 1);
		});

		test("ソースファイルは集計から除外される", () => {
			const files = [
				file("/ws/docs/ja/a.md", [unit({ status: Status.Source })], Status.Source),
				file("/ws/docs/en/a.md", [unit({ needFlag: "translate" })]),
			];
			const data = buildStatusData(files, false);
			assert.strictEqual(data.totalUnits, 1);
			assert.strictEqual(data.filesWithNeeds, 1);
			assert.strictEqual(data.filesTranslated, 0);
		});

		test("keepのみのファイルは完訳側に数える（独自ユニットは分母から除外）", () => {
			const files = [file("/ws/docs/en/a.md", [unit({ needFlag: "keep" })])];
			const data = buildStatusData(files, true);
			assert.strictEqual(data.filesWithNeeds, 0);
			assert.strictEqual(data.filesTranslated, 1);
			assert.deepStrictEqual(data.files, []);
			assert.strictEqual(data.needs.keep, 1);
		});
	});
});
