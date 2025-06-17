import * as assert from "node:assert";
import * as path from "node:path";
import * as vscode from "vscode";
import { Configuration } from "../../../config/configuration";
import { StatusCollector } from "../../../ui/status/status-collector";

suite("StatusTreeProvider Test Suite", () => {
	test("StatusCollectorが正しくファイル状況を収集できる", async () => {
		const collector = new StatusCollector();
		const config = new Configuration();

		// テスト用の設定を作成
		config.transPairs = [
			{
				sourceDir: "src/test/sample-content/ja",
				targetDir: "src/test/sample-content/en",
			},
		];
		config.ignoredPatterns = [];

		// ファイル状況を収集
		const fileStatuses = await collector.collectAllFileStatuses(config);

		// 結果の検証
		assert.ok(Array.isArray(fileStatuses), "fileStatusesは配列である必要があります");

		// サンプルファイルが存在する場合の検証
		if (fileStatuses.length > 0) {
			const firstFile = fileStatuses[0];
			assert.ok(firstFile.filePath, "filePathが設定されている必要があります");
			assert.ok(firstFile.fileName, "fileNameが設定されている必要があります");
			assert.ok(
				["translated", "needsTranslation", "error", "unknown"].includes(firstFile.status),
				"statusは有効な値である必要があります",
			);
			assert.ok(
				typeof firstFile.translatedUnits === "number",
				"translatedUnitsは数値である必要があります",
			);
			assert.ok(typeof firstFile.totalUnits === "number", "totalUnitsは数値である必要があります");
		}
	});

	test("StatusCollectorが存在しないディレクトリを適切に処理する", async () => {
		const collector = new StatusCollector();
		const config = new Configuration();

		// 存在しないディレクトリを設定
		config.transPairs = [
			{
				sourceDir: "non-existent-directory",
				targetDir: "another-non-existent-directory",
			},
		];
		config.ignoredPatterns = [];

		// ファイル状況を収集
		const fileStatuses = await collector.collectAllFileStatuses(config);

		// エラーにならずに空配列が返されることを確認
		assert.ok(Array.isArray(fileStatuses), "fileStatusesは配列である必要があります");
		assert.strictEqual(
			fileStatuses.length,
			0,
			"存在しないディレクトリの場合は空配列が返される必要があります",
		);
	});
});
