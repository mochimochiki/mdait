import * as assert from "node:assert";
import { Status, StatusItemType } from "../../../core/status/status-item";
import type { FileStatusItem, UnitStatusItem } from "../../../core/status/status-item";
import {
	MAX_UNIT_DETAILS_PER_FILE,
	buildStatusData,
	countNeedFlags,
	countNeeds,
	totalActionableNeeds,
} from "../../../lm-tools/status-data";

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
				unit({ needFlag: "isolate" }),
				unit({ needFlag: "custom-flag" }),
				unit({ needFlag: undefined, status: Status.Translated }),
			]);
			assert.strictEqual(needs.translate, 2);
			assert.strictEqual(needs.revise, 1);
			assert.strictEqual(needs.review, 1);
			assert.strictEqual(needs.verifyDeletion, 1);
			assert.strictEqual(needs.isolate, 1);
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
		test("isolateは実作業対象に含めない（定常状態）", () => {
			const needs = countNeeds([unit({ needFlag: "isolate" }), unit({ needFlag: "translate" })]);
			assert.strictEqual(totalActionableNeeds(needs), 1);
		});
	});

	suite("buildStatusData", () => {
		test("全体集計とファイル数の内訳を返す", () => {
			const files = [
				file("/ws/docs/en/a.md", [unit({ needFlag: "translate" }), unit({ status: Status.Translated })]),
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

		test("detailのファイル別totalUnitsは凍結ユニットを分母から除外する", () => {
			// 凍結ユニットは翻訳済みだが進捗の分母には入らない（Statusは偽らない）
			const files = [
				file("/ws/docs/en/a.md", [
					unit({ needFlag: "translate" }),
					unit({ status: Status.Translated }),
					unit({ needFlag: "isolate", status: Status.Translated }),
				]),
			];
			const data = buildStatusData(files, true);
			assert.ok(data.files);
			// 全体集計と同じ基準: 凍結ユニットは分母に入らない
			assert.strictEqual(data.files[0].totalUnits, 2);
			assert.strictEqual(data.files[0].translatedUnits, 1);
			assert.strictEqual(data.totalUnits, 2);
			// isolateは内訳には計上される
			assert.strictEqual(data.files[0].needs.isolate, 1);
		});

		test("isolateのみのファイルは完訳側に数える（孤立ユニットは分母から除外）", () => {
			const files = [file("/ws/docs/en/a.md", [unit({ needFlag: "isolate" })])];
			const data = buildStatusData(files, true);
			assert.strictEqual(data.filesWithNeeds, 0);
			assert.strictEqual(data.filesTranslated, 1);
			assert.deepStrictEqual(data.files, []);
			assert.strictEqual(data.needs.isolate, 1);
		});
	});

	suite("buildStatusData: detailのユニット別need一覧", () => {
		test("needのあるユニットのみhash/title/needで列挙し、needなしユニットは含めない", () => {
			const files = [
				file("/ws/docs/en/a.md", [
					unit({ unitHash: "h1", title: "Intro", needFlag: "translate" }),
					unit({ unitHash: "h2", title: "Usage", needFlag: "revise@old1" }),
					unit({ unitHash: "h3", title: "Done", status: Status.Translated }),
					unit({ unitHash: "h4", title: "Review me", needFlag: "review" }),
				]),
			];
			const data = buildStatusData(files, true);
			assert.ok(data.files);
			const units = data.files[0].units;
			assert.deepStrictEqual(
				units.map((u) => ({ hash: u.hash, title: u.title, need: u.need })),
				[
					{ hash: "h1", title: "Intro", need: "translate" },
					{ hash: "h2", title: "Usage", need: "revise@old1" },
					{ hash: "h4", title: "Review me", need: "review" },
				],
			);
			assert.strictEqual(data.files[0].unitsTruncated, undefined);
		});

		test("凍結ユニットも列挙されるが、原文ユニットは含めない", () => {
			const files = [
				file("/ws/docs/en/a.md", [
					unit({ unitHash: "h1", needFlag: "translate" }),
					unit({ unitHash: "h2", needFlag: "isolate", status: Status.Translated }),
					unit({ unitHash: "h3", needFlag: "translate", status: Status.Source }),
				]),
			];
			const data = buildStatusData(files, true);
			assert.ok(data.files);
			assert.deepStrictEqual(
				data.files[0].units.map((u) => u.hash),
				["h1", "h2"],
			);
		});

		test("titleが無いユニットはtitleフィールドを持たない", () => {
			const files = [file("/ws/docs/en/a.md", [unit({ unitHash: "h1", needFlag: "review", title: undefined })])];
			const data = buildStatusData(files, true);
			assert.ok(data.files);
			assert.strictEqual("title" in data.files[0].units[0], false);
		});

		test("1ファイルの上限を超えるユニットは切り詰められunitsTruncated:trueが付く", () => {
			const manyUnits = Array.from({ length: MAX_UNIT_DETAILS_PER_FILE + 5 }, (_, i) =>
				unit({ unitHash: `h${i}`, needFlag: "translate" }),
			);
			const data = buildStatusData([file("/ws/docs/en/a.md", manyUnits)], true);
			assert.ok(data.files);
			assert.strictEqual(data.files[0].units.length, MAX_UNIT_DETAILS_PER_FILE);
			assert.strictEqual(data.files[0].unitsTruncated, true);
			// need内訳の集計は切り詰めの影響を受けない
			assert.strictEqual(data.files[0].needs.translate, MAX_UNIT_DETAILS_PER_FILE + 5);
		});

		test("上限ちょうどのユニット数ではunitsTruncatedが付かない", () => {
			const exactUnits = Array.from({ length: MAX_UNIT_DETAILS_PER_FILE }, (_, i) =>
				unit({ unitHash: `h${i}`, needFlag: "translate" }),
			);
			const data = buildStatusData([file("/ws/docs/en/a.md", exactUnits)], true);
			assert.ok(data.files);
			assert.strictEqual(data.files[0].units.length, MAX_UNIT_DETAILS_PER_FILE);
			assert.strictEqual(data.files[0].unitsTruncated, undefined);
		});
	});

	suite("countNeedFlags", () => {
		test("needフラグ文字列一覧から内訳を集計する", () => {
			const needs = countNeedFlags(["translate", "revise@abc", "review", "verify-deletion", "isolate", "custom"]);
			assert.strictEqual(needs.translate, 1);
			assert.strictEqual(needs.revise, 1);
			assert.strictEqual(needs.review, 1);
			assert.strictEqual(needs.verifyDeletion, 1);
			assert.strictEqual(needs.isolate, 1);
			assert.strictEqual(needs.other, 1);
		});
	});
});
