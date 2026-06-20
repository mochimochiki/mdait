import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { UnitStateStore } from "../../../core/unit-state/unit-state-store";
import type { UnitStateEntry } from "../../../core/unit-state/unit-state-store";

/** テスト用一時ディレクトリを作成 */
function createTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "mdait-uss-"));
}

/** テスト用一時ディレクトリを削除 */
function cleanupTempDir(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

/** 非MD相当のエントリを生成（order=0, level=0, titleHash=""） */
function plainEntry(filePath: string, hash: string, from: string, need: string): UnitStateEntry {
	return { path: filePath, order: 0, level: 0, titleHash: "", hash, from, need };
}

suite("UnitStateStore", () => {
	let tempDir: string;

	setup(() => {
		UnitStateStore.dispose();
		tempDir = createTempDir();
	});

	teardown(() => {
		UnitStateStore.dispose();
		cleanupTempDir(tempDir);
	});

	test("シングルトンインスタンスが同一であること", () => {
		const a = UnitStateStore.getInstance();
		const b = UnitStateStore.getInstance();
		assert.strictEqual(a, b);
	});

	test("disposeでインスタンスがリセットされること", () => {
		const a = UnitStateStore.getInstance();
		UnitStateStore.dispose();
		const b = UnitStateStore.getInstance();
		assert.notStrictEqual(a, b);
	});

	test("ファイルが存在しない場合でもloadが成功すること", () => {
		const store = UnitStateStore.getInstance();
		store.load(tempDir);
		assert.deepStrictEqual(store.getAllEntries(), []);
	});

	test("setEntry/getEntryで複合キー(path,order)のCRUDが動作すること", () => {
		const store = UnitStateStore.getInstance();
		store.load(tempDir);

		const e0: UnitStateEntry = {
			path: "docs/en/a.md",
			order: 0,
			level: 1,
			titleHash: "t0t0t0t0",
			hash: "a1b2c3d4",
			from: "ff03a1b2",
			need: "",
		};
		const e1: UnitStateEntry = {
			path: "docs/en/a.md",
			order: 1,
			level: 2,
			titleHash: "t1t1t1t1",
			hash: "55667788",
			from: "99aabbcc",
			need: "translate",
		};

		store.setEntry(e0);
		store.setEntry(e1);

		// 同一pathでもorderで別物として取得できる
		assert.deepStrictEqual(store.getEntry("docs/en/a.md", 0), e0);
		assert.deepStrictEqual(store.getEntry("docs/en/a.md", 1), e1);

		// 存在しないキー
		assert.strictEqual(store.getEntry("docs/en/a.md", 2), undefined);
		assert.strictEqual(store.getEntry("nonexistent", 0), undefined);
	});

	test("removeEntryで複合キー単位に削除されること", () => {
		const store = UnitStateStore.getInstance();
		store.load(tempDir);

		store.setEntry({ path: "a.md", order: 0, level: 1, titleHash: "h0", hash: "1111", from: "2222", need: "" });
		store.setEntry({ path: "a.md", order: 1, level: 2, titleHash: "h1", hash: "3333", from: "4444", need: "" });

		store.removeEntry("a.md", 0);
		assert.strictEqual(store.getEntry("a.md", 0), undefined);
		assert.ok(store.getEntry("a.md", 1));
	});

	test("7カラムTSVのsave/load往復でデータが保持されること（MD-external + 非MD混在）", () => {
		const store = UnitStateStore.getInstance();
		store.load(tempDir);

		// MD-external: 同一pathに複数order
		store.setEntry({
			path: "docs/ja/guide.md",
			order: 0,
			level: 1,
			titleHash: "ta0",
			hash: "aaaa",
			from: "bbbb",
			need: "",
		});
		store.setEntry({
			path: "docs/ja/guide.md",
			order: 1,
			level: 2,
			titleHash: "ta1",
			hash: "cccc",
			from: "dddd",
			need: "translate",
		});
		// 非MD: order=0, level=0, titleHash=""
		store.setEntry(plainEntry("docs/ja/data.csv", "eeee", "ffff", "review"));
		store.save(tempDir);

		// 新しいインスタンスで再ロード
		UnitStateStore.dispose();
		const store2 = UnitStateStore.getInstance();
		store2.load(tempDir);

		assert.strictEqual(store2.getAllEntries().length, 3);
		assert.deepStrictEqual(store2.getEntry("docs/ja/guide.md", 0), {
			path: "docs/ja/guide.md",
			order: 0,
			level: 1,
			titleHash: "ta0",
			hash: "aaaa",
			from: "bbbb",
			need: "",
		});
		assert.deepStrictEqual(store2.getEntry("docs/ja/guide.md", 1), {
			path: "docs/ja/guide.md",
			order: 1,
			level: 2,
			titleHash: "ta1",
			hash: "cccc",
			from: "dddd",
			need: "translate",
		});
		assert.deepStrictEqual(store2.getEntry("docs/ja/data.csv", 0), plainEntry("docs/ja/data.csv", "eeee", "ffff", "review"));
	});

	test("getEntriesByPathがorder昇順で返すこと", () => {
		const store = UnitStateStore.getInstance();
		store.load(tempDir);

		// order を逆順に登録
		store.setEntry({ path: "x.md", order: 2, level: 2, titleHash: "h2", hash: "c2", from: "f2", need: "" });
		store.setEntry({ path: "x.md", order: 0, level: 1, titleHash: "h0", hash: "c0", from: "f0", need: "" });
		store.setEntry({ path: "x.md", order: 1, level: 2, titleHash: "h1", hash: "c1", from: "f1", need: "" });
		// 別pathのエントリは含まれないこと
		store.setEntry(plainEntry("y.md", "cy", "fy", ""));

		const byPath = store.getEntriesByPath("x.md");
		assert.deepStrictEqual(
			byPath.map((e) => e.order),
			[0, 1, 2],
		);
	});

	test("TSVがpath→orderの二段でソートされること", () => {
		const store = UnitStateStore.getInstance();
		store.load(tempDir);

		store.setEntry({ path: "z.md", order: 1, level: 2, titleHash: "h", hash: "1", from: "2", need: "" });
		store.setEntry({ path: "z.md", order: 0, level: 1, titleHash: "h", hash: "3", from: "4", need: "" });
		store.setEntry(plainEntry("a.md", "5", "6", "translate"));
		store.save(tempDir);

		const content = fs.readFileSync(path.join(tempDir, "unit-state"), "utf-8");
		const dataLines = content.split("\n").filter((l) => l.trim() !== "" && !l.startsWith("#"));
		assert.strictEqual(dataLines.length, 3);
		assert.ok(dataLines[0].startsWith("a.md\t0\t"));
		assert.ok(dataLines[1].startsWith("z.md\t0\t"));
		assert.ok(dataLines[2].startsWith("z.md\t1\t"));
	});

	test("cleanupOrphansで同一pathの全order行が削除されること", () => {
		const store = UnitStateStore.getInstance();
		store.load(tempDir);

		store.setEntry({ path: "keep.md", order: 0, level: 1, titleHash: "h", hash: "1", from: "2", need: "" });
		store.setEntry({ path: "orphan.md", order: 0, level: 1, titleHash: "h", hash: "3", from: "4", need: "" });
		store.setEntry({ path: "orphan.md", order: 1, level: 2, titleHash: "h", hash: "5", from: "6", need: "translate" });

		const removed = store.cleanupOrphans(new Set(["keep.md"]));

		assert.strictEqual(removed, 2);
		assert.ok(store.getEntry("keep.md", 0));
		assert.strictEqual(store.getEntry("orphan.md", 0), undefined);
		assert.strictEqual(store.getEntry("orphan.md", 1), undefined);
	});

	test("getEntriesNeedingActionがneed非空のみ返すこと", () => {
		const store = UnitStateStore.getInstance();
		store.load(tempDir);

		store.setEntry(plainEntry("done.txt", "1", "2", ""));
		store.setEntry(plainEntry("todo.txt", "3", "4", "translate"));
		store.setEntry(plainEntry("revise.csv", "5", "6", "revise@aabb"));
		store.setEntry(plainEntry("review.txt", "7", "8", "review"));

		const needAction = store.getEntriesNeedingAction();
		assert.strictEqual(needAction.length, 3);
		const paths = needAction.map((e) => e.path).sort();
		assert.deepStrictEqual(paths, ["review.txt", "revise.csv", "todo.txt"]);
	});

	test("不正行(7カラム不一致)がスキップされること", () => {
		const filePath = path.join(tempDir, "unit-state");
		const content = `${[
			"# header",
			"good.md\t0\t1\tth\taaaa\tbbbb\t",
			"bad-too-few\t0\t1",
			"bad\twith\ttoo\tmany\tcols\there\tand\there",
			"also-good.csv\t0\t0\t\tcccc\tdddd\ttranslate",
		].join("\n")}\n`;
		fs.writeFileSync(filePath, content, "utf-8");

		const store = UnitStateStore.getInstance();
		store.load(tempDir);

		assert.strictEqual(store.getAllEntries().length, 2);
		assert.ok(store.getEntry("good.md", 0));
		assert.ok(store.getEntry("also-good.csv", 0));
	});

	test("コメント行・空行がスキップされること", () => {
		const filePath = path.join(tempDir, "unit-state");
		const content = [
			"# comment 1",
			"",
			"a.md\t0\t1\tth\taaaa\tbbbb\ttranslate",
			"  ",
			"# mid comment",
			"b.csv\t0\t0\t\tcccc\tdddd\t",
			"",
		].join("\n");
		fs.writeFileSync(filePath, content, "utf-8");

		const store = UnitStateStore.getInstance();
		store.load(tempDir);

		assert.strictEqual(store.getAllEntries().length, 2);
		assert.ok(store.getEntry("a.md", 0));
		assert.ok(store.getEntry("b.csv", 0));
	});

	test("変更なしの場合saveがファイルを書き込まないこと", () => {
		const filePath = path.join(tempDir, "unit-state");
		const store = UnitStateStore.getInstance();
		store.load(tempDir);

		store.save(tempDir);
		assert.strictEqual(fs.existsSync(filePath), false);
	});

	test("冪等性: load→save→loadで内容が同一であること", () => {
		const filePath = path.join(tempDir, "unit-state");
		const originalContent = `${[
			"# mdait unit-state — 翻訳ユニットの状態管理",
			"# path\torder\tlevel\ttitleHash\thash\tfrom\tneed",
			"docs/en/a.md\t0\t1\tth0\taaaa\tbbbb\t",
			"docs/en/a.md\t1\t2\tth1\tcccc\tdddd\ttranslate",
			"docs/en/b.csv\t0\t0\t\teeee\tffff\t",
		].join("\n")}\n`;
		fs.writeFileSync(filePath, originalContent, "utf-8");

		const store = UnitStateStore.getInstance();
		store.load(tempDir);

		// setEntryで同じ値を再設定してdirtyにする
		const entry = store.getEntry("docs/en/a.md", 0);
		assert.ok(entry);
		store.setEntry(entry);

		store.save(tempDir);

		const savedContent = fs.readFileSync(filePath, "utf-8");
		assert.strictEqual(savedContent, originalContent);
	});
});
