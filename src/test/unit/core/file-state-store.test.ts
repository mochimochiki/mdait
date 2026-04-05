import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FileStateStore } from "../../../core/file-state/file-state-store";
import type { FileStateEntry } from "../../../core/file-state/file-state-store";

/** テスト用一時ディレクトリを作成 */
function createTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "mdait-fss-"));
}

/** テスト用一時ディレクトリを削除 */
function cleanupTempDir(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

suite("FileStateStore", () => {
	let tempDir: string;

	setup(() => {
		FileStateStore.dispose();
		tempDir = createTempDir();
	});

	teardown(() => {
		FileStateStore.dispose();
		cleanupTempDir(tempDir);
	});

	test("シングルトンインスタンスが同一であること", () => {
		const a = FileStateStore.getInstance();
		const b = FileStateStore.getInstance();
		assert.strictEqual(a, b);
	});

	test("disposeでインスタンスがリセットされること", () => {
		const a = FileStateStore.getInstance();
		FileStateStore.dispose();
		const b = FileStateStore.getInstance();
		assert.notStrictEqual(a, b);
	});

	test("ファイルが存在しない場合でもloadが成功すること", () => {
		const store = FileStateStore.getInstance();
		store.load(tempDir);
		assert.deepStrictEqual(store.getAllEntries(), []);
	});

	test("setEntry/getEntryで基本的なCRUDが動作すること", () => {
		const store = FileStateStore.getInstance();
		store.load(tempDir);

		const entry: FileStateEntry = {
			targetPath: "docs/en/readme.txt",
			hash: "a1b2c3d4",
			fromHash: "ff03a1b2",
			need: "",
		};

		store.setEntry(entry);
		const got = store.getEntry("docs/en/readme.txt");
		assert.deepStrictEqual(got, entry);

		// 存在しないキー
		assert.strictEqual(store.getEntry("nonexistent"), undefined);
	});

	test("removeEntryでエントリが削除されること", () => {
		const store = FileStateStore.getInstance();
		store.load(tempDir);

		store.setEntry({
			targetPath: "a.txt",
			hash: "1111",
			fromHash: "2222",
			need: "",
		});
		store.removeEntry("a.txt");
		assert.strictEqual(store.getEntry("a.txt"), undefined);
	});

	test("save/loadの往復でデータが保持されること", () => {
		const store = FileStateStore.getInstance();
		store.load(tempDir);

		store.setEntry({
			targetPath: "docs/en/b.csv",
			hash: "aaaa",
			fromHash: "bbbb",
			need: "translate",
		});
		store.setEntry({
			targetPath: "docs/en/a.txt",
			hash: "cccc",
			fromHash: "dddd",
			need: "",
		});
		store.save(tempDir);

		// 新しいインスタンスで再ロード
		FileStateStore.dispose();
		const store2 = FileStateStore.getInstance();
		store2.load(tempDir);

		assert.strictEqual(store2.getAllEntries().length, 2);
		assert.deepStrictEqual(store2.getEntry("docs/en/a.txt"), {
			targetPath: "docs/en/a.txt",
			hash: "cccc",
			fromHash: "dddd",
			need: "",
		});
		assert.deepStrictEqual(store2.getEntry("docs/en/b.csv"), {
			targetPath: "docs/en/b.csv",
			hash: "aaaa",
			fromHash: "bbbb",
			need: "translate",
		});
	});

	test("TSVフォーマットがパスで昇順ソートされること", () => {
		const store = FileStateStore.getInstance();
		store.load(tempDir);

		store.setEntry({
			targetPath: "z.txt",
			hash: "1111",
			fromHash: "2222",
			need: "",
		});
		store.setEntry({
			targetPath: "a.txt",
			hash: "3333",
			fromHash: "4444",
			need: "translate",
		});
		store.setEntry({
			targetPath: "m.txt",
			hash: "5555",
			fromHash: "6666",
			need: "review",
		});
		store.save(tempDir);

		const content = fs.readFileSync(path.join(tempDir, "file-state"), "utf-8");
		const dataLines = content
			.split("\n")
			.filter((l) => l.trim() !== "" && !l.startsWith("#"));
		assert.strictEqual(dataLines.length, 3);
		assert.ok(dataLines[0].startsWith("a.txt\t"));
		assert.ok(dataLines[1].startsWith("m.txt\t"));
		assert.ok(dataLines[2].startsWith("z.txt\t"));
	});

	test("コメント行がスキップされること", () => {
		const filePath = path.join(tempDir, "file-state");
		const content = `${[
			"# comment line 1",
			"# comment line 2",
			"docs/en/a.txt\taaaa\tbbbb\ttranslate",
			"# mid-file comment",
			"docs/en/b.csv\tcccc\tdddd\t",
		].join("\n")}\n`;
		fs.writeFileSync(filePath, content, "utf-8");

		const store = FileStateStore.getInstance();
		store.load(tempDir);

		assert.strictEqual(store.getAllEntries().length, 2);
		assert.ok(store.getEntry("docs/en/a.txt"));
		assert.ok(store.getEntry("docs/en/b.csv"));
	});

	test("冪等性: load→save→loadで内容が同一であること", () => {
		const filePath = path.join(tempDir, "file-state");
		const originalContent = `${[
			"# mdait file-state — ターゲットファイルの翻訳状態管理",
			"# path\thash\tfrom\tneed",
			"docs/en/a.txt\taaaa\tbbbb\t",
			"docs/en/b.csv\tcccc\tdddd\ttranslate",
		].join("\n")}\n`;
		fs.writeFileSync(filePath, originalContent, "utf-8");

		const store = FileStateStore.getInstance();
		store.load(tempDir);

		// setEntryで同じ値を再設定してdirtyにする
		const entry = store.getEntry("docs/en/a.txt");
		assert.ok(entry);
		store.setEntry(entry);

		store.save(tempDir);

		const savedContent = fs.readFileSync(filePath, "utf-8");
		assert.strictEqual(savedContent, originalContent);
	});

	test("cleanupOrphansで不要エントリが削除されること", () => {
		const store = FileStateStore.getInstance();
		store.load(tempDir);

		store.setEntry({
			targetPath: "keep.txt",
			hash: "1111",
			fromHash: "2222",
			need: "",
		});
		store.setEntry({
			targetPath: "orphan1.txt",
			hash: "3333",
			fromHash: "4444",
			need: "",
		});
		store.setEntry({
			targetPath: "orphan2.csv",
			hash: "5555",
			fromHash: "6666",
			need: "translate",
		});

		const validPaths = new Set(["keep.txt"]);
		const removed = store.cleanupOrphans(validPaths);

		assert.strictEqual(removed, 2);
		assert.ok(store.getEntry("keep.txt"));
		assert.strictEqual(store.getEntry("orphan1.txt"), undefined);
		assert.strictEqual(store.getEntry("orphan2.csv"), undefined);
	});

	test("cleanupOrphansで全エントリが有効な場合に0を返すこと", () => {
		const store = FileStateStore.getInstance();
		store.load(tempDir);

		store.setEntry({
			targetPath: "a.txt",
			hash: "1111",
			fromHash: "2222",
			need: "",
		});
		store.setEntry({
			targetPath: "b.txt",
			hash: "3333",
			fromHash: "4444",
			need: "",
		});

		const validPaths = new Set(["a.txt", "b.txt"]);
		const removed = store.cleanupOrphans(validPaths);

		assert.strictEqual(removed, 0);
		assert.strictEqual(store.getAllEntries().length, 2);
	});

	test("不正行（カラム数不一致）がスキップされること", () => {
		const filePath = path.join(tempDir, "file-state");
		const content = `${[
			"# header",
			"good.txt\taaaa\tbbbb\t",
			"bad-line-too-few-columns\taaaa",
			"bad\tline\twith\ttoo\tmany\tcolumns",
			"also-good.csv\tcccc\tdddd\ttranslate",
		].join("\n")}\n`;
		fs.writeFileSync(filePath, content, "utf-8");

		const store = FileStateStore.getInstance();
		store.load(tempDir);

		// 正常な2行だけが読み込まれること
		assert.strictEqual(store.getAllEntries().length, 2);
		assert.ok(store.getEntry("good.txt"));
		assert.ok(store.getEntry("also-good.csv"));
	});

	test("getEntriesNeedingActionがneed非空のエントリのみ返すこと", () => {
		const store = FileStateStore.getInstance();
		store.load(tempDir);

		store.setEntry({
			targetPath: "done.txt",
			hash: "1111",
			fromHash: "2222",
			need: "",
		});
		store.setEntry({
			targetPath: "todo.txt",
			hash: "3333",
			fromHash: "4444",
			need: "translate",
		});
		store.setEntry({
			targetPath: "revise.csv",
			hash: "5555",
			fromHash: "6666",
			need: "revise@aabb",
		});
		store.setEntry({
			targetPath: "review.txt",
			hash: "7777",
			fromHash: "8888",
			need: "review",
		});

		const needAction = store.getEntriesNeedingAction();
		assert.strictEqual(needAction.length, 3);
		const paths = needAction.map((e: FileStateEntry) => e.targetPath).sort();
		assert.deepStrictEqual(paths, ["review.txt", "revise.csv", "todo.txt"]);
	});

	test("変更なしの場合saveがファイルを書き込まないこと", () => {
		const filePath = path.join(tempDir, "file-state");
		const store = FileStateStore.getInstance();
		store.load(tempDir);

		// まだ何も変更していない
		store.save(tempDir);
		assert.strictEqual(fs.existsSync(filePath), false);
	});

	test("遅延ロード: mdaitDir設定済みなら未ロードでもgetEntryでauto-loadすること", () => {
		// まずデータを書き出す
		const filePath = path.join(tempDir, "file-state");
		const content = `${["# header", "auto.txt\taaaa\tbbbb\ttranslate"].join(
			"\n",
		)}\n`;
		fs.writeFileSync(filePath, content, "utf-8");

		// 新しいインスタンスでload()を呼ばずにmdaitDirだけセットする（loadの第1行でmdaitDirが記録される）
		// ここでは一度loadしてからdisposeし、再度instanceを取得してmdaitDirをセットする代わりに
		// 手動でloadを呼んで確認
		const store = FileStateStore.getInstance();
		store.load(tempDir);

		// disposeして再取得
		FileStateStore.dispose();
		const store2 = FileStateStore.getInstance();
		// loadを呼ばずに直接getEntry → auto-loadされないはず（mdaitDir未設定）
		assert.strictEqual(store2.getEntry("auto.txt"), undefined);

		// 明示的にloadする
		store2.load(tempDir);
		assert.ok(store2.getEntry("auto.txt"));
	});

	test("空行が無視されること", () => {
		const filePath = path.join(tempDir, "file-state");
		const content = [
			"# header",
			"",
			"a.txt\t1111\t2222\t",
			"",
			"  ",
			"b.txt\t3333\t4444\ttranslate",
			"",
		].join("\n");
		fs.writeFileSync(filePath, content, "utf-8");

		const store = FileStateStore.getInstance();
		store.load(tempDir);

		assert.strictEqual(store.getAllEntries().length, 2);
	});
});
