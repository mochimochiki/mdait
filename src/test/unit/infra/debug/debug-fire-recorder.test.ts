import * as assert from "node:assert";
import * as path from "node:path";
import { type FileStatusItem, Status, StatusItemType } from "../../../../core/status/status-item";
import { StatusItemTree } from "../../../../core/status/status-item-tree";
import { DebugFireRecorder } from "../../../../infra/debug/debug-fire-recorder";
import { analyzeSync, diffSnapshots } from "../../../../infra/debug/debug-sync-analyzer";

declare let __vscodeMockWorkspaceRoot: string;

function makeFileItem(filePath: string, status: Status = Status.NeedsTranslation): FileStatusItem {
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

suite("DebugFireRecorder / sync-analyzer", () => {
	const recorder = DebugFireRecorder.getInstance();

	setup(() => {
		__vscodeMockWorkspaceRoot = "/mock-workspace";
		recorder.enable();
	});

	suite("DebugFireRecorder", () => {
		test("enabled=false の間は record/start/stop が完全 no-op（本番安全性）", () => {
			recorder.disable();
			recorder.start(); // no-op
			recorder.record("tree", undefined); // no-op
			const events = recorder.stop(); // 常に空配列
			assert.strictEqual(events.length, 0, "未有効時は履歴を持たない");
			assert.strictEqual(recorder.isEnabled(), false);
			recorder.enable(); // 後続テストのため戻す
		});

		test("recording 停止中の record は履歴に残らない", () => {
			recorder.start();
			recorder.stop();
			recorder.record("tree", undefined); // recording=false の間は無視
			recorder.start();
			const events = recorder.stop();
			assert.strictEqual(events.length, 0, "recording停止中の record は履歴に残らない");
		});

		test("StatusItemTree の fire が tree ソースとして記録される", () => {
			const tree = new StatusItemTree();
			const jaDir = path.resolve("/mock-workspace/ja");
			const file = makeFileItem(path.join(jaDir, "a.md"));
			tree.buildTree([file], ["ja"]);

			recorder.start();
			// 部分更新 → fireTreeChanged 経由で記録されるはず
			tree.updateFilePartial(file.filePath, { status: Status.Translated });
			const events = recorder.stop();
			tree.dispose();

			assert.ok(events.length >= 1, "updateFilePartial で fire が記録される");
			assert.ok(
				events.every((e) => e.source === "tree"),
				"全イベントが tree ソース",
			);
		});
	});

	suite("diffSnapshots", () => {
		test("変化したファイルのみ差分として返す", () => {
			const before = {
				"/x/a.md": "needsTranslation|t0/1",
				"/x/b.md": "source",
			};
			const after = { "/x/a.md": "translated|t1/1", "/x/b.md": "source" };
			const diffs = diffSnapshots(before, after);
			assert.strictEqual(diffs.length, 1);
			assert.strictEqual(diffs[0].path, "/x/a.md");
			assert.strictEqual(diffs[0].before, "needsTranslation|t0/1");
			assert.strictEqual(diffs[0].after, "translated|t1/1");
		});

		test("追加・削除も差分として検出する", () => {
			const diffs = diffSnapshots({ "/x/a.md": "v1" }, { "/x/b.md": "v2" });
			assert.strictEqual(diffs.length, 2);
		});
	});

	suite("analyzeSync（同期ギャップ検出）", () => {
		const jaDir = path.resolve("/mock-workspace/ja");
		const filePath = path.join(jaDir, "a.md");
		const fileDiff = {
			path: filePath,
			before: "needsTranslation",
			after: "translated",
		};

		test("ファイル一致 fire があればギャップ無し", () => {
			const result = analyzeSync(
				[fileDiff],
				[
					{
						seq: 0,
						source: "tree",
						kind: StatusItemType.File,
						path: filePath,
						at: "t",
					},
				],
			);
			assert.strictEqual(result.syncGaps.length, 0);
		});

		test("全体更新(all) fire があればギャップ無し", () => {
			const result = analyzeSync([fileDiff], [{ seq: 0, source: "tree", kind: "all", at: "t" }]);
			assert.strictEqual(result.syncGaps.length, 0);
		});

		test("ディレクトリ通知のみ → directory-only ギャップとして検出", () => {
			const result = analyzeSync(
				[fileDiff],
				[
					{
						seq: 0,
						source: "tree",
						kind: StatusItemType.Directory,
						path: jaDir,
						at: "t",
					},
				],
			);
			assert.strictEqual(result.syncGaps.length, 1);
			assert.ok(result.syncGaps[0].reason.startsWith("directory-only"));
		});

		test("fire が一切無い → NOT-FIRED ギャップとして検出", () => {
			const result = analyzeSync([fileDiff], []);
			assert.strictEqual(result.syncGaps.length, 1);
			assert.ok(result.syncGaps[0].reason.startsWith("NOT-FIRED"));
		});

		test("兄弟ディレクトリ(同名プレフィックス)の fire を誤って directory-only 扱いしない", () => {
			// fire は /mock-workspace/ja-backup（兄弟）だが diff は /mock-workspace/ja 配下
			const result = analyzeSync(
				[fileDiff],
				[
					{
						seq: 0,
						source: "tree",
						kind: StatusItemType.Directory,
						path: path.resolve("/mock-workspace/ja-backup"),
						at: "t",
					},
				],
			);
			assert.strictEqual(result.syncGaps.length, 1);
			assert.ok(result.syncGaps[0].reason.startsWith("NOT-FIRED"), "兄弟ディレクトリ通知は親通知とみなさず NOT-FIRED");
		});
	});
});
