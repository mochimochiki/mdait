// 「レビュー待ちを AI で一括消化する」入口が対象ファイルを決める部分の検証。
// ツリーの項目から need:review を拾う規則（本文・frontmatter・非Markdown）と、
// 拾ってはいけないもの（verify-deletion など）、並びの安定を固定する。

import * as assert from "node:assert";
import * as path from "node:path";
import {
	type PendingReviewFileLike,
	collectPendingReviewFiles,
} from "../../../../commands/ai-review/pending-review-files";
import { type FileStatusItem, Status, StatusItemType, type UnitStatusItem } from "../../../../core/status/status-item";

const jaDir = path.resolve("/mock-workspace/ja");
const aPath = path.join(jaDir, "a.md");
const bPath = path.join(jaDir, "b.md");
const cPath = path.join(jaDir, "c.md");

function makeUnit(filePath: string, unitHash: string, needFlag: string | undefined): UnitStatusItem {
	return {
		type: StatusItemType.Unit,
		label: unitHash,
		filePath,
		unitHash,
		needFlag,
		status: needFlag ? Status.NeedsTranslation : Status.Translated,
	};
}

function makeFile(filePath: string, children: UnitStatusItem[]): FileStatusItem {
	return {
		type: StatusItemType.File,
		label: path.basename(filePath),
		filePath,
		fileName: path.basename(filePath),
		status: Status.NeedsTranslation,
		translatedUnits: 0,
		totalUnits: children.length,
		children,
	};
}

suite("collectPendingReviewFiles（レビュー待ちの対象ファイル選別）", () => {
	test("need:review のユニットを持つファイルだけが集まり、ユニット数も数えられる", () => {
		const files = [
			makeFile(aPath, [makeUnit(aPath, "a1", "review"), makeUnit(aPath, "a2", undefined)]),
			makeFile(bPath, [makeUnit(bPath, "b1", "translate"), makeUnit(bPath, "b2", undefined)]),
			makeFile(cPath, [makeUnit(cPath, "c1", "review"), makeUnit(cPath, "c2", "review")]),
		];

		const result = collectPendingReviewFiles(files);

		assert.deepStrictEqual(result.files, [aPath, cPath]);
		assert.strictEqual(result.units, 3);
	});

	test("verify-deletion・translate・revise・isolate は拾わない", () => {
		const files = [
			makeFile(aPath, [
				makeUnit(aPath, "a1", "verify-deletion"),
				makeUnit(aPath, "a2", "translate"),
				makeUnit(aPath, "a3", "revise@abc"),
				makeUnit(aPath, "a4", "isolate"),
			]),
		];

		const result = collectPendingReviewFiles(files);

		assert.deepStrictEqual(result.files, []);
		assert.strictEqual(result.units, 0);
	});

	test("同じファイルに review が複数あってもファイルは1回だけ並ぶ", () => {
		const files = [
			makeFile(aPath, [
				makeUnit(aPath, "a1", "review"),
				makeUnit(aPath, "a2", "review"),
				makeUnit(aPath, "a3", "review"),
			]),
		];

		const result = collectPendingReviewFiles(files);

		assert.deepStrictEqual(result.files, [aPath]);
		assert.strictEqual(result.units, 3);
	});

	test("同じパスの項目が二度渡っても、走らせるのも数えるのも一度だけ", () => {
		const item = makeFile(aPath, [makeUnit(aPath, "a1", "review")]);

		const result = collectPendingReviewFiles([item, item]);

		assert.deepStrictEqual(result.files, [aPath]);
		assert.strictEqual(result.units, 1);
	});

	test("入力の順序に関わらずファイルパス昇順で並ぶ", () => {
		const files = [
			makeFile(cPath, [makeUnit(cPath, "c1", "review")]),
			makeFile(aPath, [makeUnit(aPath, "a1", "review")]),
			makeFile(bPath, [makeUnit(bPath, "b1", "review")]),
		];

		const forward = collectPendingReviewFiles(files);
		const reversed = collectPendingReviewFiles([...files].reverse());

		assert.deepStrictEqual(forward.files, [aPath, bPath, cPath]);
		assert.deepStrictEqual(reversed.files, forward.files);
	});

	test("frontmatter の need:review は本文に review が無くても対象になる", () => {
		const file: PendingReviewFileLike = {
			filePath: aPath,
			frontmatter: { needFlag: "review" },
			children: [{ needFlag: undefined }],
		};

		const result = collectPendingReviewFiles([file]);

		assert.deepStrictEqual(result.files, [aPath]);
		assert.strictEqual(result.units, 1);
	});

	test("frontmatter が review 以外（translate）なら対象にならない", () => {
		const file: PendingReviewFileLike = {
			filePath: aPath,
			frontmatter: { needFlag: "translate" },
			children: [],
		};

		const result = collectPendingReviewFiles([file]);

		assert.deepStrictEqual(result.files, []);
		assert.strictEqual(result.units, 0);
	});

	test("非Markdown（ファイルレベルの need:review・children なし）も対象になる", () => {
		const txtPath = path.join(jaDir, "notes.txt");
		const file: PendingReviewFileLike = {
			filePath: txtPath,
			needFlag: "review",
			children: [],
		};

		const result = collectPendingReviewFiles([file]);

		assert.deepStrictEqual(result.files, [txtPath]);
		assert.strictEqual(result.units, 1);
	});

	test("本文・frontmatter・非Markdown の review を合算して数える", () => {
		const txtPath = path.join(jaDir, "notes.txt");
		const files: PendingReviewFileLike[] = [
			{
				filePath: aPath,
				frontmatter: { needFlag: "review" },
				children: [{ needFlag: "review" }, { needFlag: "verify-deletion" }],
			},
			{ filePath: txtPath, needFlag: "review" },
		];

		const result = collectPendingReviewFiles(files);

		assert.deepStrictEqual(result.files, [aPath, txtPath]);
		assert.strictEqual(result.units, 3);
	});

	test("原文と結びついていない訳文（孤立）は review が残っていても拾わない", () => {
		// 原文が無いので対にできず、走らせても「原文が見つからない」のエラーになるだけ
		const orphan: FileStatusItem = { ...makeFile(aPath, [makeUnit(aPath, "a1", "review")]), isOrphanTarget: true };
		const files = [orphan, makeFile(bPath, [makeUnit(bPath, "b1", "review")])];

		const result = collectPendingReviewFiles(files);

		assert.deepStrictEqual(result.files, [bPath]);
		assert.strictEqual(result.units, 1);
	});

	test("原文側のファイルは review が残っていても拾わない", () => {
		const source: FileStatusItem = { ...makeFile(aPath, [makeUnit(aPath, "a1", "review")]), status: Status.Source };
		const files = [source, makeFile(bPath, [makeUnit(bPath, "b1", "review")])];

		const result = collectPendingReviewFiles(files);

		assert.deepStrictEqual(result.files, [bPath]);
		assert.strictEqual(result.units, 1);
	});

	test("空の入力では空の結果になる", () => {
		const result = collectPendingReviewFiles([]);

		assert.deepStrictEqual(result.files, []);
		assert.strictEqual(result.units, 0);
	});
});
