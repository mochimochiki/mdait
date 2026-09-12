// ツリー行アクションの出し分け（contextValue）と、翻訳率の分母判定の回帰テスト。
//
// 背景: 凍結ユニット（need:isolate）を翻訳率の分母から外すために Status.Source を
// 名乗らせていたところ、contextValue が Status を先に見ていたため巻き添えで
// "mdaitUnitSource" に吸われ、"mdaitUnitIsolated" の分岐へ到達できなかった。
// その結果、ツリーの「凍結を解除」が一度も表示されなかった。
//
// 以後 contextValue は Status を引数に取らない。ここはその不変条件を守る番人である。

import * as assert from "node:assert";
import { StatusCollector } from "../../../../commands/file-handler/status-collector";
import type { MdaitUnit } from "../../../../core/markdown/mdait-unit";
import { Status, StatusItemType, type UnitStatusItem, isCountedInProgress } from "../../../../core/status/status-item";
import { StatusItemTree } from "../../../../core/status/status-item-tree";

/** マーカーだけを持つ最小のユニットを作る */
function unit(need: string | null, from: string | null): MdaitUnit {
	return {
		marker: {
			hash: "aaaa",
			from,
			need,
			needsTranslation(): boolean {
				return need === "translate" || (need ?? "").startsWith("revise@");
			},
		},
	} as unknown as MdaitUnit;
}

/** private メソッドを名前で呼ぶ（収集したユニット項目そのものが検証対象のため） */
function collectUnits(units: MdaitUnit[], isSourceFile: boolean): UnitStatusItem[] {
	const collector = new StatusCollector() as unknown as {
		collectUnitsStatus(
			units: readonly MdaitUnit[],
			filePath: string,
			fileName: string,
			isSourceFile: boolean,
		): UnitStatusItem[];
	};
	return collector.collectUnitsStatus(units, "/ws/ja/a.md", "a.md", isSourceFile);
}

/** private メソッドを名前で呼ぶ（出し分けの判定そのものが検証対象のため） */
function derive(u: MdaitUnit): { status: Status; contextValue: string } {
	const collector = new StatusCollector() as unknown as {
		determineUnitStatus(u: MdaitUnit): Status;
		determineUnitContextValue(u: MdaitUnit): string;
	};
	return {
		status: collector.determineUnitStatus(u),
		contextValue: collector.determineUnitContextValue(u),
	};
}

function statusItem(needFlag: string | undefined, status: Status): UnitStatusItem {
	return {
		type: StatusItemType.Unit,
		label: "u",
		status,
		filePath: "/ws/en/a.md",
		unitHash: "aaaa",
		needFlag,
	};
}

suite("ユニットの状態導出（contextValue と分母判定）", () => {
	test("凍結ユニットは mdaitUnitIsolated になる（ツリーの解除アクションが出る条件）", () => {
		const { contextValue } = derive(unit("isolate", "srcA"));
		assert.strictEqual(contextValue, "mdaitUnitIsolated");
	});

	test("原文側の凍結ユニットも同じ mdaitUnitIsolated になる（宣言は両側で行える）", () => {
		const { contextValue } = derive(unit("isolate", null));
		assert.strictEqual(contextValue, "mdaitUnitIsolated");
	});

	test("凍結ユニットの Status は Source と偽らず Translated になる", () => {
		const { status } = derive(unit("isolate", "srcA"));
		assert.strictEqual(status, Status.Translated);
	});

	test("レビュー待ちは mdaitUnitTargetAttention になる（裁定アクションが出る条件）", () => {
		const { contextValue } = derive(unit("review", "srcA"));
		assert.strictEqual(contextValue, "mdaitUnitTargetAttention");
	});

	test("削除確認待ちは mdaitUnitTargetVerifyDeletion になる", () => {
		const { contextValue } = derive(unit("verify-deletion", "srcA"));
		assert.strictEqual(contextValue, "mdaitUnitTargetVerifyDeletion");
	});

	test("要翻訳は mdaitUnitTarget になる（▶ が出る条件）", () => {
		const { contextValue } = derive(unit("translate", "srcA"));
		assert.strictEqual(contextValue, "mdaitUnitTarget");
	});

	test("翻訳済みは mdaitUnitTargetCompletePaired になる", () => {
		const { contextValue, status } = derive(unit(null, "srcA"));
		assert.strictEqual(contextValue, "mdaitUnitTargetCompletePaired");
		assert.strictEqual(status, Status.Translated);
	});

	test("原文ユニットは mdaitUnitSource になる", () => {
		const { contextValue, status } = derive(unit(null, null));
		assert.strictEqual(contextValue, "mdaitUnitSource");
		assert.strictEqual(status, Status.Source);
	});

	// 独立ユニットも from が無いので Status.Source を名乗る。原文のユニットと同じ形に
	// なるため、どちら側のファイルかを併せて見ないと区別できない
	test("訳文の from なしユニットには独立ユニットの印が付く", () => {
		const [item] = collectUnits([unit(null, null)], false);
		assert.strictEqual(item.isIndependent, true);
	});

	test("原文ファイルのユニットには独立ユニットの印を付けない", () => {
		const [item] = collectUnits([unit(null, null)], true);
		assert.strictEqual(item.isIndependent, false);
	});

	test("凍結ユニットには独立ユニットの印を付けない", () => {
		const [item] = collectUnits([unit("isolate", "srcA")], false);
		assert.strictEqual(item.isIndependent, false);
	});

	test("凍結ユニットは翻訳率の分母に数えない（Status を偽らずに除外できている）", () => {
		assert.strictEqual(isCountedInProgress(statusItem("isolate", Status.Translated)), false);
	});

	test("原文ユニットは翻訳率の分母に数えない", () => {
		assert.strictEqual(isCountedInProgress(statusItem(undefined, Status.Source)), false);
	});

	test("通常の訳文ユニットは翻訳率の分母に数える", () => {
		assert.strictEqual(isCountedInProgress(statusItem(undefined, Status.Translated)), true);
		assert.strictEqual(isCountedInProgress(statusItem("review", Status.NeedsTranslation)), true);
	});

	test("ツリー全体の進捗集計でも凍結ユニットは分母に入らない", () => {
		// 分母判定を Status で書いた集計が残っていると、凍結ユニットが
		// 「翻訳済み」として二重に数えられる（isCountedInProgress へ委ねること）
		const tree = new StatusItemTree();
		tree.addOrUpdateFile({
			type: StatusItemType.File,
			label: "a.md",
			status: Status.Translated,
			filePath: "/ws/en/a.md",
			fileName: "a.md",
			translatedUnits: 1,
			totalUnits: 1,
			children: [
				{ ...statusItem(undefined, Status.Translated), unitHash: "u1" },
				{ ...statusItem("isolate", Status.Translated), unitHash: "u2" },
				{ ...statusItem(undefined, Status.Source), unitHash: "u3" },
			],
		});

		const progress = tree.aggregateProgress();
		assert.strictEqual(progress.totalUnits, 1, "凍結ユニットと原文ユニットは分母に入らない");
		assert.strictEqual(progress.translatedUnits, 1);
	});
});
