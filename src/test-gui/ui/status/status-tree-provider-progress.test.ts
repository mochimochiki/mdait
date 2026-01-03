import * as assert from "node:assert";
import * as vscode from "vscode";
import { Status, type FileStatusItem, StatusItemType } from "../../../core/status/status-item";
import { StatusTreeProvider } from "../../../ui/status/status-tree-provider";

suite("StatusTreeProvider 進行中アイコン表示テスト", () => {
	test("isTranslatingがtrueのときsync~spinアイコンが返る", () => {
		const provider = new StatusTreeProvider();
		const item: FileStatusItem = {
			type: StatusItemType.File,
			label: "test.md",
			filePath: "test.md",
			fileName: "test.md",
			translatedUnits: 0,
			totalUnits: 1,
			status: Status.NeedsTranslation,
			isTranslating: true,
		};
		const treeItem = provider.getTreeItem(item);
		assert.strictEqual(
			treeItem.iconPath instanceof vscode.ThemeIcon && treeItem.iconPath.id,
			"sync~spin",
			"isTranslating=trueならsync~spinアイコンになること",
		);
	});

	test("isTranslatingがfalseのとき通常アイコンが返る", () => {
		const provider = new StatusTreeProvider();
		const item: FileStatusItem = {
			type: StatusItemType.File,
			label: "test.md",
			filePath: "test.md",
			fileName: "test.md",
			translatedUnits: 0,
			totalUnits: 1,
			status: Status.NeedsTranslation,
			isTranslating: false,
		};
		const treeItem = provider.getTreeItem(item);
		assert.strictEqual(
			treeItem.iconPath instanceof vscode.ThemeIcon && treeItem.iconPath.id,
			"circle",
			"isTranslating=falseなら通常アイコンになること",
		);
	});
});
