// 「次の要対応へ」の移動先決定ロジックの検証（UX-R4 / ADR-260724-01）。
// 要対応キューは「次へ」があって初めてキューとして機能するため、
// 前進・末尾からの折り返し・起点が無い場合の3つを固定する。

import * as assert from "node:assert";
import * as path from "node:path";
import { findNextIndex } from "../../../../commands/markers/needs-attention-next";
import { type FileStatusItem, Status, StatusItemType, type UnitStatusItem } from "../../../../core/status/status-item";
import { StatusItemTree } from "../../../../core/status/status-item-tree";

declare let __vscodeMockWorkspaceRoot: string;

const jaDir = path.resolve("/mock-workspace/ja");
const aPath = path.join(jaDir, "a.md");
const bPath = path.join(jaDir, "b.md");

function makeUnit(filePath: string, unitHash: string, startLine: number): UnitStatusItem {
	return {
		type: StatusItemType.Unit,
		label: unitHash,
		filePath,
		unitHash,
		needFlag: "review",
		status: Status.NeedsTranslation,
		startLine,
	};
}

function makeFile(filePath: string, children: UnitStatusItem[]): FileStatusItem {
	return {
		type: StatusItemType.File,
		label: path.basename(filePath),
		filePath,
		fileName: path.basename(filePath),
		translatedUnits: 0,
		totalUnits: children.length,
		status: Status.NeedsTranslation,
		children,
	};
}

/** ツリーが返すのと同じ順序（compareNeedsAttentionUnits 適用済み）のキューを作る */
function buildQueue(): UnitStatusItem[] {
	const tree = new StatusItemTree();
	try {
		tree.buildTree(
			[
				makeFile(aPath, [makeUnit(aPath, "a5", 5), makeUnit(aPath, "a80", 80)]),
				makeFile(bPath, [makeUnit(bPath, "b10", 10)]),
			],
			["ja"],
		);
		return tree.getNeedsAttentionUnits();
	} finally {
		tree.dispose();
	}
}

suite("findNextIndex（次の要対応へ）", () => {
	let units: UnitStatusItem[];

	setup(() => {
		__vscodeMockWorkspaceRoot = "/mock-workspace";
		units = buildQueue();
	});

	test("キューの順序がファイルパス昇順→開始行昇順であること（前提の確認）", () => {
		assert.deepStrictEqual(
			units.map((u) => u.unitHash),
			["a5", "a80", "b10"],
		);
	});

	test("起点が無ければ先頭を返すこと", () => {
		assert.strictEqual(findNextIndex(units, undefined), 0);
	});

	test("同一ファイル内で現在行より後ろの項目へ進むこと", () => {
		assert.strictEqual(findNextIndex(units, { filePath: aPath, line: 5 }), 1);
	});

	test("スクロール先の行を起点にすると、その次の項目へ進むこと（前へ戻らないこと）", () => {
		// CodeLensのクリックはカーソルを動かさないため、押した行を起点に渡す必要がある。
		// 80行目を起点にしたら、先頭(5行目)ではなく次のファイルの項目へ進む。
		assert.strictEqual(findNextIndex(units, { filePath: aPath, line: 80 }), 2);
	});

	test("ファイル内に後続が無ければ次のファイルの項目へ進むこと", () => {
		assert.strictEqual(findNextIndex(units, { filePath: aPath, line: 100 }), 2);
	});

	test("末尾まで来たら先頭へ回ること（行き止まりにしない）", () => {
		assert.strictEqual(findNextIndex(units, { filePath: bPath, line: 10 }), 0);
	});

	test("要対応と無関係なファイルを開いている場合もパス順で次の項目を選ぶこと", () => {
		const otherPath = path.join(jaDir, "0-other.md"); // a.md より前
		assert.strictEqual(findNextIndex(units, { filePath: otherPath, line: 0 }), 0);
		const laterPath = path.join(jaDir, "z-other.md"); // b.md より後
		assert.strictEqual(findNextIndex(units, { filePath: laterPath, line: 0 }), 0, "以降に項目が無ければ先頭へ回ること");
	});
});
