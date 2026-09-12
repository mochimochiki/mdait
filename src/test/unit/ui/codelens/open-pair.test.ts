/**
 * @file open-pair.test.ts
 * @description 訳文を原文と並べて開く（`mdait.openPair`）の、vscode に依らない判断の検証。
 * - 訳文をどの列に開くか（既に見えていればその列、無ければ左端）
 * - from の無いユニット（verify-deletion・独立ユニット）では原文を探さない
 * - 原文ユニットは対になる原文ファイルを先に、無ければ全体から探す
 * 要対応キューを順に回るとき「訳文は左・原文は右」が項目をまたいで保たれることを固定する。
 */

import { strict as assert } from "node:assert";
import type * as vscode from "vscode";
import { Status, StatusItemType, type UnitStatusItem } from "../../../../core/status/status-item";
import { locatePairSource, pickViewColumnForTarget } from "../../../../ui/codelens/codelens-command";

// モックの vscode には ViewColumn が無いので、実体（数値列挙）と同じ値を型だけ合わせて使う
const ONE = 1 as vscode.ViewColumn;
const TWO = 2 as vscode.ViewColumn;
const THREE = 3 as vscode.ViewColumn;

type VisibleEditor = { document: { uri: { fsPath: string } }; viewColumn?: vscode.ViewColumn };

function visible(fsPath: string, viewColumn?: vscode.ViewColumn): VisibleEditor {
	return { document: { uri: { fsPath } }, viewColumn };
}

const TARGET = "/ws/docs/ja/guide.md";
const SOURCE = "/ws/docs/en/guide.md";

suite("pickViewColumnForTarget（訳文を開く列の決め方）", () => {
	test("どこにも見えていなければ左端（fallback）に開くこと — アクティブ列ではない", () => {
		// 前の項目で右に出した原文プレビューがアクティブなとき、そこへ訳文を開くと3列になる
		const editors = [visible(SOURCE, TWO)];
		assert.strictEqual(pickViewColumnForTarget(editors, TARGET, ONE), ONE);
	});

	test("既にどこかの列に見えていればその列を使うこと（利用者の置き場所を尊重する）", () => {
		const editors = [visible("/ws/other.md", ONE), visible(TARGET, THREE)];
		assert.strictEqual(pickViewColumnForTarget(editors, TARGET, ONE), THREE);
	});

	test("見えているエディタが無ければ fallback を返すこと", () => {
		assert.strictEqual(pickViewColumnForTarget([], TARGET, ONE), ONE);
	});

	test("同じファイルでも列が分からないエディタ（viewColumn 無し）は当てにせず fallback を返すこと", () => {
		const editors = [visible(TARGET, undefined)];
		assert.strictEqual(pickViewColumnForTarget(editors, TARGET, ONE), ONE);
	});

	test("パスは完全一致で比べること（別ファイルの列を拾わない）", () => {
		const editors = [visible(`${TARGET}.bak`, TWO), visible("/ws/docs/ja/guide2.md", THREE)];
		assert.strictEqual(pickViewColumnForTarget(editors, TARGET, ONE), ONE);
	});
});

function makeSourceUnit(filePath: string, unitHash: string): UnitStatusItem {
	return {
		type: StatusItemType.Unit,
		label: unitHash,
		filePath,
		unitHash,
		status: Status.Source,
		startLine: 3,
		endLine: 9,
	};
}

/** getUnit（ファイル指定）と getUnitByHash（全体）の呼ばれ方を控える偽ツリー */
function makeTree(byPath: Record<string, UnitStatusItem>, byHash: Record<string, UnitStatusItem>) {
	const calls: string[] = [];
	return {
		calls,
		getUnit: (hash: string, filePath: string) => {
			calls.push(`getUnit:${filePath}#${hash}`);
			return byPath[`${filePath}#${hash}`];
		},
		getUnitByHash: (hash: string) => {
			calls.push(`getUnitByHash:${hash}`);
			return byHash[hash];
		},
	};
}

suite("locatePairSource（対訳の原文ユニットの探し方）", () => {
	test("from が無ければ原文を探さないこと（verify-deletion・独立ユニットは原文が無いのがふつう）", () => {
		const tree = makeTree({}, {});
		assert.deepStrictEqual(locatePairSource(tree, null, SOURCE), { kind: "no-from" });
		assert.deepStrictEqual(locatePairSource(tree, undefined, SOURCE), { kind: "no-from" });
		assert.deepStrictEqual(locatePairSource(tree, "", SOURCE), { kind: "no-from" });
		assert.deepStrictEqual(tree.calls, [], "from が無いときはツリーに問い合わせない");
	});

	test("対になる原文ファイルにあればそれを返し、全体検索はしないこと", () => {
		const unit = makeSourceUnit(SOURCE, "srcA");
		const tree = makeTree({ [`${SOURCE}#srcA`]: unit }, { srcA: makeSourceUnit("/ws/docs/en/other.md", "srcA") });
		const located = locatePairSource(tree, "srcA", SOURCE);
		assert.deepStrictEqual(located, { kind: "found", from: "srcA", unit });
		assert.deepStrictEqual(tree.calls, [`getUnit:${SOURCE}#srcA`]);
	});

	test("対になる原文ファイルに無ければ全体から探すこと（原文が別ファイルへ移った場合）", () => {
		const moved = makeSourceUnit("/ws/docs/en/moved.md", "srcA");
		const tree = makeTree({}, { srcA: moved });
		const located = locatePairSource(tree, "srcA", SOURCE);
		assert.deepStrictEqual(located, { kind: "found", from: "srcA", unit: moved });
		assert.deepStrictEqual(tree.calls, [`getUnit:${SOURCE}#srcA`, "getUnitByHash:srcA"]);
	});

	test("対になる原文ファイルが推定できなければ最初から全体を探すこと", () => {
		const unit = makeSourceUnit(SOURCE, "srcA");
		const tree = makeTree({}, { srcA: unit });
		assert.deepStrictEqual(locatePairSource(tree, "srcA", null), { kind: "found", from: "srcA", unit });
		assert.deepStrictEqual(tree.calls, ["getUnitByHash:srcA"]);
	});

	test("どこにも無ければ not-found と探した from を返すこと（呼び出し側が通知文に使う）", () => {
		const tree = makeTree({}, {});
		assert.deepStrictEqual(locatePairSource(tree, "gone", SOURCE), { kind: "not-found", from: "gone" });
	});
});
