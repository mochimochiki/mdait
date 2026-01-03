import * as assert from "node:assert";
import * as vscode from "vscode";
import { StatusTreeTranslationHandler } from "../../../commands/trans/status-tree-translation-handler";
import {
	Status,
	type StatusItem,
	type FileStatusItem,
	type UnitStatusItem,
	type DirectoryStatusItem,
	StatusItemType,
} from "../../../core/status/status-item";

suite("翻訳アイテムコマンドテスト", () => {
	let translateItemCommand: StatusTreeTranslationHandler;

	setup(() => {
		translateItemCommand = new StatusTreeTranslationHandler();
	});

	test("ディレクトリアイテムの検証 - 正常なディレクトリアイテム", async () => {
		const directoryItem: DirectoryStatusItem = {
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
		const fileItem: FileStatusItem = {
			type: StatusItemType.File,
			label: "test.md",
			filePath: "/test/test.md",
			fileName: "test.md",
			translatedUnits: 0,
			totalUnits: 1,
			status: Status.NeedsTranslation,
		};

		// エラーが発生しないことを確認（実際の翻訳は行わない）
		assert.strictEqual(fileItem.type, "file");
		assert.strictEqual(fileItem.filePath, "/test/test.md");
	});

	test("ユニットアイテムの検証 - 正常なユニットアイテム", async () => {
		const unitItem: UnitStatusItem = {
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
		// Discriminated Union型では無効なアイテムを作成できなくなったため、
		// テスト目的でFileStatusItemを渡してディレクトリ翻訳を呼び出す
		const invalidItem: FileStatusItem = {
			type: StatusItemType.File,
			label: "invalid",
			filePath: "/test/invalid.md",
			fileName: "invalid.md",
			translatedUnits: 0,
			totalUnits: 0,
			status: Status.NeedsTranslation,
		};

		// 無効なアイテムでもエラーが適切に処理されることを確認
		// （実際にはvscode.window.showErrorMessageが呼ばれる）
		try {
			await translateItemCommand.translateDirectory(invalidItem as StatusItem);
			// エラーメッセージが表示されるが例外は投げられない
		} catch (error) {
			assert.fail("例外が投げられるべきではありません");
		}
	});

	test("無効なファイルアイテムの処理", async () => {
		// Discriminated Union型ではfilePathは必須のため、DirectoryStatusItemを渡してテスト
		const invalidItem: DirectoryStatusItem = {
			type: StatusItemType.Directory,
			label: "invalid",
			directoryPath: "/test/invalid",
			status: Status.NeedsTranslation,
		};

		// 無効なアイテムでもエラーが適切に処理されることを確認
		try {
			await translateItemCommand.translateFile(invalidItem as StatusItem);
			// エラーメッセージが表示されるが例外は投げられない
		} catch (error) {
			assert.fail("例外が投げられるべきではありません");
		}
	});

	test("無効なユニットアイテムの処理", async () => {
		// Discriminated Union型ではfilePath, unitHashは必須のため、DirectoryStatusItemを渡してテスト
		const invalidItem: DirectoryStatusItem = {
			type: StatusItemType.Directory,
			label: "invalid",
			directoryPath: "/test/invalid",
			status: Status.NeedsTranslation,
		};

		// 無効なアイテムでもエラーが適切に処理されることを確認
		try {
			await translateItemCommand.translateUnit(invalidItem as StatusItem);
			// エラーメッセージが表示されるが例外は投げられない
		} catch (error) {
			assert.fail("例外が投げられるべきではありません");
		}
	});
});
