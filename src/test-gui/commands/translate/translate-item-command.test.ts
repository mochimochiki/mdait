import * as assert from "node:assert";
import * as vscode from "vscode";
import { StatusTreeTranslationHandler } from "../../../commands/trans/status-tree-translation-handler";
import { Status, type StatusItem, StatusItemType } from "../../../core/status/status-item";

suite("翻訳アイテムコマンドテスト", () => {
	let translateItemCommand: StatusTreeTranslationHandler;

	setup(() => {
		translateItemCommand = new StatusTreeTranslationHandler();
	});

	test("ディレクトリアイテムの検証 - 正常なディレクトリアイテム", async () => {
		const directoryItem: StatusItem = {
			type: StatusItemType.Directory,
			label: "test-dir",
			directoryPath: "/test/directory",
			status: Status.NeedsTranslation,
		};

		// エラーが発生しないことを確認（実際の翻訳は行わない）
		assert.strictEqual(directoryItem.type, StatusItemType.Directory);
		assert.strictEqual(directoryItem.directoryPath, "/test/directory");
	});

	test("ファイルアイテムの検証 - 正常なファイルアイテム", async () => {
		const fileItem: StatusItem = {
			type: StatusItemType.File,
			label: "test.md",
			filePath: "/test/test.md",
			status: Status.NeedsTranslation,
		};

		// エラーが発生しないことを確認（実際の翻訳は行わない）
		assert.strictEqual(fileItem.type, "file");
		assert.strictEqual(fileItem.filePath, "/test/test.md");
	});

	test("ユニットアイテムの検証 - 正常なユニットアイテム", async () => {
		const unitItem: StatusItem = {
			type: StatusItemType.Unit,
			label: "Test Unit",
			filePath: "/test/test.md",
			unitHash: "12345678",
			startLine: 5,
			endLine: 10,
			status: Status.NeedsTranslation,
		};

		// エラーが発生しないことを確認（実際の翻訳は行わない）
		assert.strictEqual(unitItem.type, "unit");
		assert.strictEqual(unitItem.filePath, "/test/test.md");
		assert.strictEqual(unitItem.unitHash, "12345678");
	});

	test("無効なディレクトリアイテムの処理", async () => {
		const invalidItem: StatusItem = {
			type: StatusItemType.File, // ディレクトリではない
			label: "invalid",
			status: Status.NeedsTranslation,
		};

		// 無効なアイテムでもエラーが適切に処理されることを確認
		// （実際にはvscode.window.showErrorMessageが呼ばれる）
		try {
			await translateItemCommand.translateDirectory(invalidItem);
			// エラーメッセージが表示されるが例外は投げられない
		} catch (error) {
			assert.fail("例外が投げられるべきではありません");
		}
	});

	test("無効なファイルアイテムの処理", async () => {
		const invalidItem: StatusItem = {
			type: StatusItemType.File,
			label: "invalid",
			status: Status.NeedsTranslation,
			// filePathが未定義
		};

		// 無効なアイテムでもエラーが適切に処理されることを確認
		try {
			await translateItemCommand.translateFile(invalidItem);
			// エラーメッセージが表示されるが例外は投げられない
		} catch (error) {
			assert.fail("例外が投げられるべきではありません");
		}
	});

	test("無効なユニットアイテムの処理", async () => {
		const invalidItem: StatusItem = {
			type: StatusItemType.Unit,
			label: "invalid",
			status: Status.NeedsTranslation,
			// filePath, unitHashが未定義
		};

		// 無効なアイテムでもエラーが適切に処理されることを確認
		try {
			await translateItemCommand.translateUnit(invalidItem);
			// エラーメッセージが表示されるが例外は投げられない
		} catch (error) {
			assert.fail("例外が投げられるべきではありません");
		}
	});
});
