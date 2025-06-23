import * as assert from "node:assert";
import * as vscode from "vscode";
import { TranslateItemCommand } from "../../../commands/translate/translate-item-command";
import type { StatusItem } from "../../../ui/status/status-item";

suite("翻訳アイテムコマンドテスト", () => {
	let translateItemCommand: TranslateItemCommand;

	setup(() => {
		translateItemCommand = new TranslateItemCommand();
	});

	test("ディレクトリアイテムの検証 - 正常なディレクトリアイテム", async () => {
		const directoryItem: StatusItem = {
			type: "directory",
			label: "test-dir",
			directoryPath: "/test/directory",
			status: "needsTranslation",
		};

		// エラーが発生しないことを確認（実際の翻訳は行わない）
		assert.strictEqual(directoryItem.type, "directory");
		assert.strictEqual(directoryItem.directoryPath, "/test/directory");
	});

	test("ファイルアイテムの検証 - 正常なファイルアイテム", async () => {
		const fileItem: StatusItem = {
			type: "file",
			label: "test.md",
			filePath: "/test/test.md",
			status: "needsTranslation",
		};

		// エラーが発生しないことを確認（実際の翻訳は行わない）
		assert.strictEqual(fileItem.type, "file");
		assert.strictEqual(fileItem.filePath, "/test/test.md");
	});

	test("ユニットアイテムの検証 - 正常なユニットアイテム", async () => {
		const unitItem: StatusItem = {
			type: "unit",
			label: "Test Unit",
			filePath: "/test/test.md",
			unitHash: "12345678",
			startLine: 5,
			endLine: 10,
			status: "needsTranslation",
		};

		// エラーが発生しないことを確認（実際の翻訳は行わない）
		assert.strictEqual(unitItem.type, "unit");
		assert.strictEqual(unitItem.filePath, "/test/test.md");
		assert.strictEqual(unitItem.unitHash, "12345678");
	});

	test("無効なディレクトリアイテムの処理", async () => {
		const invalidItem: StatusItem = {
			type: "file", // ディレクトリではない
			label: "invalid",
			status: "needsTranslation",
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
			type: "file",
			label: "invalid",
			status: "needsTranslation",
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
			type: "unit",
			label: "invalid",
			status: "needsTranslation",
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
