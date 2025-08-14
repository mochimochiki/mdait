import * as assert from "node:assert";
import * as path from "node:path";
import * as vscode from "vscode";
import { Configuration } from "../../../config/configuration";
import { Status } from "../../../core/status/status-item";
import { StatusManager } from "../../../core/status/status-manager";

suite("StatusTreeProvider Test Suite", () => {
	test("StatusManagerが正しくファイル状況を収集できる", async () => {
		const statusManager = StatusManager.getInstance();
		Configuration.dispose();
		const config = Configuration.getInstance();

		// テスト用の設定を作成
		config.transPairs = [
			{
				sourceLang: "ja",
				sourceDir: "src/test/sample-content/ja",
				targetLang: "en",
				targetDir: "src/test/sample-content/en",
			},
		];

		// ファイル状況を収集
		await statusManager.buildStatusItemTree();
		const fileStatuses = statusManager.getTreeFileStatusList();

		// 結果の検証
		assert.ok(Array.isArray(fileStatuses), "fileStatusesは配列である必要があります");

		// サンプルファイルが存在する場合の検証
		if (fileStatuses.length > 0) {
			const firstFile = fileStatuses[0];
			assert.ok(firstFile.filePath, "filePathが設定されている必要があります");
			assert.ok(firstFile.fileName, "fileNameが設定されている必要があります");
			assert.ok(
				[Status.Translated, Status.NeedsTranslation, Status.Error, Status.Unknown].includes(firstFile.status),
				"statusは有効な値である必要があります",
			);
			assert.ok(typeof firstFile.translatedUnits === "number", "translatedUnitsは数値である必要があります");
			assert.ok(typeof firstFile.totalUnits === "number", "totalUnitsは数値である必要があります");
		}
	});

	test("StatusManagerが存在しないディレクトリを適切に処理する", async () => {
		const statusManager = StatusManager.getInstance();
		Configuration.dispose();
		const config = Configuration.getInstance();

		// 存在しないディレクトリを設定
		config.transPairs = [
			{
				sourceLang: "ja",
				sourceDir: "non-existent-directory",
				targetLang: "en",
				targetDir: "another-non-existent-directory",
			},
		];

		// ファイル状況を収集
		await statusManager.buildStatusItemTree();
		const fileStatuses = statusManager.getTreeFileStatusList();

		// エラーにならずに空配列が返されることを確認
		assert.strictEqual(fileStatuses.length, 0, "存在しないディレクトリの場合は空配列が返される必要があります");
	});

	test("StatusManagerがシングルトンパターンで動作する", () => {
		const instance1 = StatusManager.getInstance();
		const instance2 = StatusManager.getInstance();

		assert.strictEqual(instance1, instance2, "同じインスタンスが返される必要があります");
	});

	test("StatusManagerの初期化フラグが正しく動作する", async () => {
		const statusManager = StatusManager.getInstance();

		// 初期状態では未初期化
		const initialState = statusManager.isInitialized();

		Configuration.dispose();
		const config = Configuration.getInstance();
		config.transPairs = [
			{
				sourceLang: "ja",
				sourceDir: "src/test/sample-content/ja",
				targetLang: "en",
				targetDir: "src/test/sample-content/en",
			},
		];

		// rebuildStatusItemAll実行後は初期化済み
		await statusManager.buildStatusItemTree();
		const afterRebuild = statusManager.isInitialized();

		assert.strictEqual(afterRebuild, true, "rebuildStatusItemAll実行後は初期化済みになる必要があります");
	});

	test("StatusManagerの進捗集計機能が正しく動作する", async () => {
		const statusManager = StatusManager.getInstance();
		Configuration.dispose();
		const config = Configuration.getInstance();

		config.transPairs = [
			{
				sourceLang: "ja",
				sourceDir: "src/test/sample-content/ja",
				targetLang: "en",
				targetDir: "src/test/sample-content/en",
			},
		];

		await statusManager.buildStatusItemTree();

		const progress = statusManager.aggregateProgress();

		assert.ok(typeof progress.totalUnits === "number", "totalUnitsは数値である必要があります");
		assert.ok(typeof progress.translatedUnits === "number", "translatedUnitsは数値である必要があります");
		assert.ok(typeof progress.errorUnits === "number", "errorUnitsは数値である必要があります");
		assert.ok(progress.totalUnits >= 0, "totalUnitsは0以上である必要があります");
		assert.ok(progress.translatedUnits >= 0, "translatedUnitsは0以上である必要があります");
		assert.ok(progress.errorUnits >= 0, "errorUnitsは0以上である必要があります");
	});
});
