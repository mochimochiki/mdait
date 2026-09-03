// ツリー行の状態表示の検証。
// 状態の差がアイコンの色だけだと、色を見分けにくい人にもアイコンの意味を知らない人にも
// 伝わらない。未翻訳と要改訂を文字でも読めること、翻訳済みでは何も出さないことを保証する。

import * as assert from "node:assert";
import {
	Status,
	StatusItemType,
	type UnitStatusItem,
} from "../../../../core/status/status-item";
import {
	StatusTreeProvider,
	getStateDescription,
} from "../../../../ui/status/status-tree-provider";

declare let __vscodeMockWorkspaceRoot: string;

function makeUnitItem(overrides: Partial<UnitStatusItem> = {}): UnitStatusItem {
	return {
		type: StatusItemType.Unit,
		label: "Introduction",
		filePath: "/mock-workspace/docs/a.md",
		unitHash: "abc123",
		status: Status.NeedsTranslation,
		...overrides,
	};
}

suite("getStateDescription（ツリー行の状態の文字表示）", () => {
	test("未翻訳と要改訂は別の文言になる", () => {
		const notTranslated = getStateDescription(Status.NeedsTranslation, "translate");
		const needsRevision = getStateDescription(Status.NeedsTranslation, "revise@bae62c29");
		assert.ok(notTranslated, "未翻訳に文言が出ること");
		assert.ok(needsRevision, "要改訂に文言が出ること");
		assert.notStrictEqual(
			notTranslated,
			needsRevision,
			"未翻訳と要改訂が同じ文言だと一覧で区別できない",
		);
	});

	test("翻訳済み（need なし）は何も出さない", () => {
		assert.strictEqual(getStateDescription(Status.Translated, undefined), undefined);
	});

	test("裁定待ちの各状態にもそれぞれの文言が出る", () => {
		assert.ok(getStateDescription(Status.NeedsTranslation, "review"));
		assert.ok(getStateDescription(Status.NeedsTranslation, "verify-deletion"));
		assert.ok(getStateDescription(Status.NeedsTranslation, "isolate"));
	});
});

suite("StatusTreeProvider 状態の副題", () => {
	let provider: StatusTreeProvider;

	setup(() => {
		__vscodeMockWorkspaceRoot = "/mock-workspace";
		provider = new StatusTreeProvider();
	});

	test("未翻訳ユニットの副題に状態が出る", () => {
		const treeItem = provider.getTreeItem(makeUnitItem({ needFlag: "translate" }));
		assert.strictEqual(
			treeItem.description,
			getStateDescription(Status.NeedsTranslation, "translate"),
		);
	});

	test("要改訂ユニットは未翻訳と違う副題になる", () => {
		const notTranslated = provider.getTreeItem(makeUnitItem({ needFlag: "translate" }));
		const needsRevision = provider.getTreeItem(
			makeUnitItem({ needFlag: "revise@bae62c29" }),
		);
		assert.notStrictEqual(notTranslated.description, needsRevision.description);
	});

	test("明示的な description がある項目（要対応キュー）はそのまま優先される", () => {
		const treeItem = provider.getTreeItem(
			makeUnitItem({ needFlag: "review", description: "a.md · Review" }),
		);
		assert.strictEqual(treeItem.description, "a.md · Review");
	});

	test("翻訳済みユニットには副題を出さない", () => {
		const treeItem = provider.getTreeItem(makeUnitItem({ status: Status.Translated }));
		assert.strictEqual(treeItem.description, undefined);
	});
});
