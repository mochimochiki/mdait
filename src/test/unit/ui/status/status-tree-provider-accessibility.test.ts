// StatusTreeProvider のスクリーンリーダー対応（accessibilityInformation）の検証。
// tooltip（状態説明だけの文）が aria-label になると、読み上げでどの項目か分からなくなる。
// 読み上げラベルは「名前 — 状態」を含み、表示ラベル・tooltip 自体は変えないことを保証する。

import * as assert from "node:assert";
import type * as vscode from "vscode";
import { Status, StatusItemType, type UnitStatusItem } from "../../../../core/status/status-item";
import { StatusTreeProvider } from "../../../../ui/status/status-tree-provider";

declare let __vscodeMockWorkspaceRoot: string;

function makeUnitItem(overrides: Partial<UnitStatusItem> = {}): UnitStatusItem {
	return {
		type: StatusItemType.Unit,
		label: "Introduction",
		filePath: "/mock-workspace/docs/ja/a.md",
		unitHash: "abc123",
		status: Status.NeedsTranslation,
		...overrides,
	};
}

suite("StatusTreeProvider 読み上げラベル（accessibilityInformation）", () => {
	let provider: StatusTreeProvider;

	setup(() => {
		__vscodeMockWorkspaceRoot = "/mock-workspace";
		provider = new StatusTreeProvider();
	});

	test("ユニットの読み上げラベルに名前と状態の両方が含まれる", () => {
		const treeItem = provider.getTreeItem(makeUnitItem());
		const accessible = treeItem.accessibilityInformation?.label ?? "";
		assert.strictEqual(accessible, "Introduction — Translation needed", "「名前 — 状態」の形で読み上げられること");
	});

	test("needフラグ付きユニットは状態としてneedの説明が読み上げられる", () => {
		const treeItem = provider.getTreeItem(makeUnitItem({ needFlag: "review" }));
		const accessible = treeItem.accessibilityInformation?.label ?? "";
		assert.strictEqual(accessible, "Introduction — Review required");
	});

	test("副題（description）がある場合は読み上げラベルに含まれ、tooltipの改行は読点相当になる", () => {
		const treeItem = provider.getTreeItem(
			makeUnitItem({
				isVirtualCopy: true,
				description: "a.md · Review",
				tooltip: "docs/ja/a.md\nReview",
			}),
		);
		const accessible = treeItem.accessibilityInformation?.label ?? "";
		assert.strictEqual(
			accessible,
			"Introduction — a.md · Review — docs/ja/a.md, Review",
			"名前・副題・状態がすべて読み上げられ、改行が「, 」に置換されること",
		);
	});

	test("表示ラベルとtooltipは従来どおり変わらない", () => {
		const treeItem: vscode.TreeItem = provider.getTreeItem(makeUnitItem());
		assert.strictEqual(treeItem.label, "Introduction");
		assert.strictEqual(treeItem.tooltip, "Translation needed");
	});
});
