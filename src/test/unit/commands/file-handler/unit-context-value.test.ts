// ツリー行アクションの出し分け（contextValue）と、翻訳率の分母判定の回帰テスト。
//
// 背景: 凍結ユニット（need:isolate）を翻訳率の分母から外すために Status.Source を
// 名乗らせていたところ、contextValue が Status を先に見ていたため巻き添えで
// "mdaitUnitSource" に吸われ、"mdaitUnitIsolated" の分岐へ到達できなかった。
// その結果、ツリーの「独立扱いを解除」が一度も表示されなかった。
//
// 以後 contextValue は Status を引数に取らない。ここはその不変条件を守る番人である。

import * as assert from "node:assert";
import { StatusCollector } from "../../../../commands/file-handler/status-collector";
import type { MdaitUnit } from "../../../../core/markdown/mdait-unit";
import {
	Status,
	type UnitStatusItem,
	StatusItemType,
	isCountedInProgress,
} from "../../../../core/status/status-item";

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
});
