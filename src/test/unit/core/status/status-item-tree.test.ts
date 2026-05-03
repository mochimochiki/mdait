import * as assert from "node:assert";
import * as path from "node:path";
import {
	type FileStatusItem,
	Status,
	StatusItemType,
} from "../../../../core/status/status-item";
import { StatusItemTree } from "../../../../core/status/status-item-tree";

declare let __vscodeMockWorkspaceRoot: string;

/** テスト用 FileStatusItem を生成 */
function makeFileItem(
	filePath: string,
	status: Status = Status.NeedsTranslation,
): FileStatusItem {
	return {
		type: StatusItemType.File,
		label: path.basename(filePath),
		filePath,
		fileName: path.basename(filePath),
		translatedUnits: 0,
		totalUnits: 1,
		status,
	};
}

suite("StatusItemTree", () => {
	let tree: StatusItemTree;

	setup(() => {
		__vscodeMockWorkspaceRoot = "/mock-workspace"; // 他テストが変更した場合でも確実にリセット
		tree = new StatusItemTree();
	});

	teardown(() => {
		tree.dispose();
	});

	suite("buildTree / getRootDir（サブフォルダシナリオ）", () => {
		test("configBaseDir を渡すとサブフォルダ基準でルートが解決されること", () => {
			// サブフォルダ（/mock-workspace/sub）を configBaseDir として渡す
			const configBaseDir = path.resolve("/mock-workspace/sub");
			const jaDir = path.resolve(configBaseDir, "ja");
			const fileItem = makeFileItem(path.join(jaDir, "file.md"));

			tree.buildTree([fileItem], ["ja"], configBaseDir);

			// サブフォルダ基準で ja ディレクトリが登録されていること
			const jaItem = tree.getDirectory(jaDir);
			assert.ok(
				jaItem,
				"configBaseDirのサブフォルダ基準でjaディレクトリが登録されていること",
			);
		});

		test("configBaseDir なしの場合でもワークスペースルート基準で動作すること", () => {
			// configBaseDir なし → mock の workspaceFolders[0] (/mock-workspace) を使用
			const jaDir = path.resolve("/mock-workspace/ja");
			const fileItem = makeFileItem(path.join(jaDir, "file.md"));

			assert.doesNotThrow(() => {
				tree.buildTree([fileItem], ["ja"]);
			});

			const jaItem = tree.getDirectory(jaDir);
			assert.ok(
				jaItem,
				"ワークスペースルート基準でjaディレクトリが登録されていること",
			);
		});

		test("buildTree後にclearすると全データがリセットされること", () => {
			const configBaseDir = path.resolve("/mock-workspace/sub");
			const jaDir = path.resolve(configBaseDir, "ja");
			const fileItem = makeFileItem(path.join(jaDir, "file.md"));

			tree.buildTree([fileItem], ["ja"], configBaseDir);
			assert.ok(!tree.isEmpty(), "buildTree後はファイルが登録されていること");

			tree.clear();
			assert.ok(tree.isEmpty(), "clear後はファイルが空であること");
		});

		test("ワークスペースルートと異なるconfigBaseDirでもディレクトリが正しく登録されること", () => {
			// workspaceRoot = /mock-workspace, configBaseDir = /mock-workspace/sub
			// この2つが異なる場合でもパスが正しく解決される
			const configBaseDir = path.resolve("/mock-workspace/sub");
			const enDir = path.resolve(configBaseDir, "en");
			const jaDir = path.resolve(configBaseDir, "ja");
			const sourceFile = makeFileItem(
				path.join(enDir, "doc.md"),
				Status.Source,
			);
			const targetFile = makeFileItem(
				path.join(jaDir, "doc.md"),
				Status.NeedsTranslation,
			);

			tree.buildTree([sourceFile, targetFile], ["en", "ja"], configBaseDir);

			assert.ok(tree.getDirectory(enDir), "enディレクトリが登録されていること");
			assert.ok(tree.getDirectory(jaDir), "jaディレクトリが登録されていること");
		});

		test("buildTree後に外部からaddOrUpdateFileを呼ぶとonTreeChangedイベントが発火すること", () => {
			// バグ2シナリオ: 翻訳後にrefreshFileStatus → addOrUpdateFile が呼ばれるケース
			// buildTreeでconfigBaseDirを設定した後、外部からaddOrUpdateFileを呼んでも
			// getRootDirがconfigBaseDirを使って正しくルートを解決し、イベントが発火することを確認する
			const configBaseDir = path.resolve("/mock-workspace/sub");
			const jaDir = path.resolve(configBaseDir, "ja");
			const initialFileItem = makeFileItem(path.join(jaDir, "file1.md"));

			tree.buildTree([initialFileItem], ["ja"], configBaseDir);

			// buildTree後にリスナーを登録して外部呼び出しのイベントを検知
			let firedCount = 0;
			tree.onTreeChanged(() => {
				firedCount++;
			});

			// 翻訳完了後にrefreshFileStatusから呼ばれるシナリオを再現
			const translatedFileItem = makeFileItem(
				path.join(jaDir, "file1.md"),
				Status.Translated,
			);
			tree.addOrUpdateFile(translatedFileItem);

			assert.strictEqual(
				firedCount,
				1,
				"addOrUpdateFile後にonTreeChangedイベントが1回発火すること",
			);
		});
	});
});
