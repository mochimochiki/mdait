import * as assert from "node:assert";
import * as vscode from "vscode";
import { OperationRegistry } from "../../../../commands/shared/operation-registry";
import { Status, type FileStatusItem, StatusItemType } from "../../../../core/status/status-item";
import { StatusTreeProvider } from "../../../../ui/status/status-tree-provider";

function fileItem(filePath: string): FileStatusItem {
	return {
		type: StatusItemType.File,
		label: "test.md",
		filePath,
		fileName: "test.md",
		translatedUnits: 0,
		totalUnits: 1,
		status: Status.NeedsTranslation,
	};
}

suite("StatusTreeProvider 進行中アイコン表示テスト", () => {
	teardown(() => {
		OperationRegistry.dispose();
	});

	test("実行台帳に登録されている間はsync~spinアイコンが返る", () => {
		const provider = new StatusTreeProvider();
		const handle = OperationRegistry.getInstance().acquire({
			kind: "translate",
			scope: "file",
			path: "/ws/test.md",
		});
		assert.ok(handle, "台帳に登録できること");

		const treeItem = provider.getTreeItem(fileItem("/ws/test.md"));
		assert.strictEqual(
			treeItem.iconPath instanceof vscode.ThemeIcon && treeItem.iconPath.id,
			"sync~spin",
			"処理中ならsync~spinアイコンになること",
		);
	});

	test("台帳から解放されると通常アイコンに戻る", () => {
		const provider = new StatusTreeProvider();
		const handle = OperationRegistry.getInstance().acquire({
			kind: "translate",
			scope: "file",
			path: "/ws/test.md",
		});
		handle?.release();

		const treeItem = provider.getTreeItem(fileItem("/ws/test.md"));
		assert.strictEqual(
			treeItem.iconPath instanceof vscode.ThemeIcon && treeItem.iconPath.id,
			"circle",
			"処理中でなければ通常アイコンになること",
		);
	});
});
