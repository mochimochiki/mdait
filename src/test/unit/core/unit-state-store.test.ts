import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { UnitStateStore, isPathInScannedDirs } from "../../../core/unit-state/unit-state-store";
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

	test("cleanupOrphansInScopeで走査範囲内の見つからなかったpathの全order行が削除されること", () => {
		const store = UnitStateStore.getInstance();
		store.load(tempDir);

		store.setEntry({ path: "ja/keep.md", order: 0, level: 1, titleHash: "h", hash: "1", from: "2", need: "" });
		store.setEntry({ path: "ja/orphan.md", order: 0, level: 1, titleHash: "h", hash: "3", from: "4", need: "" });
		store.setEntry({ path: "ja/orphan.md", order: 1, level: 2, titleHash: "h", hash: "5", from: "6", need: "translate" });

		const removed = store.cleanupOrphansInScope({
			scannedDirs: ["ja"],
			seenPaths: new Set(["ja/keep.md"]),
		});

		assert.strictEqual(removed, 2);
		assert.ok(store.getEntry("ja/keep.md", 0));
		assert.strictEqual(store.getEntry("ja/orphan.md", 0), undefined);
		assert.strictEqual(store.getEntry("ja/orphan.md", 1), undefined);
	});

	test("cleanupOrphansInScopeが走査していないディレクトリの行を残すこと", () => {
		const store = UnitStateStore.getInstance();
		store.load(tempDir);

		store.setEntry({ path: "en/guide.md", order: 0, level: 1, titleHash: "h", hash: "1", from: "2", need: "" });
		store.setEntry({ path: "fr/guide.md", order: 0, level: 1, titleHash: "h", hash: "3", from: "4", need: "" });

		// en だけを走査した（fr は未選択の pair なので見に行っていない）
		const removed = store.cleanupOrphansInScope({
			scannedDirs: ["ja", "en"],
			seenPaths: new Set(["ja/guide.md", "en/guide.md"]),
		});

		assert.strictEqual(removed, 0);
		assert.ok(store.getEntry("fr/guide.md", 0));
	});

	test("cleanupOrphansInScopeが名前の先頭が同じ別ディレクトリを範囲内と誤判定しないこと", () => {
		const store = UnitStateStore.getInstance();
		store.load(tempDir);

		store.setEntry({ path: "content/en2/guide.md", order: 0, level: 1, titleHash: "h", hash: "1", from: "", need: "" });

		const removed = store.cleanupOrphansInScope({
			scannedDirs: ["content/en"],
			seenPaths: new Set<string>(),
		});

		assert.strictEqual(removed, 0);
		assert.ok(store.getEntry("content/en2/guide.md", 0));
	});

	test("isPathInScannedDirsがディレクトリ境界まで見て判定すること", () => {
		assert.strictEqual(isPathInScannedDirs("content/en/a.md", ["content/en"]), true);
		assert.strictEqual(isPathInScannedDirs("content/en/sub/a.md", ["content/en"]), true);
		assert.strictEqual(isPathInScannedDirs("content/en2/a.md", ["content/en"]), false);
		assert.strictEqual(isPathInScannedDirs("content/en/a.md", ["content/en/"]), true);
		assert.strictEqual(isPathInScannedDirs("content/en/a.md", []), false);
		// ワークスペースルート自体を走査した場合は全てが範囲内
		assert.strictEqual(isPathInScannedDirs("content/en/a.md", [""]), true);
	});

	suite("pruneEntriesFrom", () => {
		test("指定order以降の行だけが削除されること", () => {
			const store = UnitStateStore.getInstance();
			store.load(tempDir);

			for (let i = 0; i < 4; i++) {
				store.setEntry({ path: "ja/a.md", order: i, level: 2, titleHash: "t", hash: `h${i}`, from: "", need: "" });
			}

			const removed = store.pruneEntriesFrom("ja/a.md", 2);

			assert.strictEqual(removed, 2);
			assert.ok(store.getEntry("ja/a.md", 0));
			assert.ok(store.getEntry("ja/a.md", 1));
			assert.strictEqual(store.getEntry("ja/a.md", 2), undefined);
			assert.strictEqual(store.getEntry("ja/a.md", 3), undefined);
		});

		test("他のpathの行には触れないこと", () => {
			const store = UnitStateStore.getInstance();
			store.load(tempDir);

			store.setEntry({ path: "ja/a.md", order: 0, level: 2, titleHash: "t", hash: "h", from: "", need: "" });
			store.setEntry({ path: "ja/b.md", order: 0, level: 2, titleHash: "t", hash: "h", from: "", need: "" });
			store.setEntry({ path: "ja/b.md", order: 1, level: 2, titleHash: "t", hash: "h", from: "", need: "" });

			const removed = store.pruneEntriesFrom("ja/b.md", 0);

			assert.strictEqual(removed, 2);
			assert.ok(store.getEntry("ja/a.md", 0));
			assert.strictEqual(store.getEntry("ja/b.md", 0), undefined);
		});

		test("削除対象が無ければ0を返し保存対象にしないこと", () => {
			const store = UnitStateStore.getInstance();
			store.load(tempDir);

			store.setEntry({ path: "ja/a.md", order: 0, level: 2, titleHash: "t", hash: "h", from: "", need: "" });
			store.save(tempDir);
			const before = fs.readFileSync(path.join(tempDir, "unit-state"), "utf-8");

			const removed = store.pruneEntriesFrom("ja/a.md", 5);

			assert.strictEqual(removed, 0);
			// dirty が立たないので save は書き換えない
			store.save(tempDir);
			assert.strictEqual(fs.readFileSync(path.join(tempDir, "unit-state"), "utf-8"), before);
		});

		test("orderが飛んでいても指定order以上をすべて削除すること", () => {
			const store = UnitStateStore.getInstance();
			store.load(tempDir);

			store.setEntry({ path: "ja/a.md", order: 0, level: 2, titleHash: "t", hash: "h", from: "", need: "" });
			store.setEntry({ path: "ja/a.md", order: 7, level: 2, titleHash: "t", hash: "h", from: "", need: "" });
			store.setEntry({ path: "ja/a.md", order: 9, level: 2, titleHash: "t", hash: "h", from: "", need: "" });

			const removed = store.pruneEntriesFrom("ja/a.md", 1);

			assert.strictEqual(removed, 2);
			assert.deepStrictEqual(
				store.getEntriesByPath("ja/a.md").map((e) => e.order),
				[0],
			);
		});

		test("削除した結果がファイルへ保存されること", () => {
			const store = UnitStateStore.getInstance();
			store.load(tempDir);

			store.setEntry({ path: "ja/a.md", order: 0, level: 2, titleHash: "t", hash: "h0", from: "", need: "" });
			store.setEntry({ path: "ja/a.md", order: 1, level: 2, titleHash: "t", hash: "h1", from: "", need: "" });
			store.save(tempDir);

			store.pruneEntriesFrom("ja/a.md", 1);
			store.save(tempDir);

			const dataLines = fs
				.readFileSync(path.join(tempDir, "unit-state"), "utf-8")
				.split("\n")
				.filter((l) => l.trim() !== "" && !l.startsWith("#"));
			assert.strictEqual(dataLines.length, 1);
			assert.ok(dataLines[0].startsWith("ja/a.md\t0\t"));
		});
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

	test("冪等性: load→save→loadで内容が同一であること（path境界の空行アンカー込み）", () => {
		const filePath = path.join(tempDir, "unit-state");
		// 正準形: path が変わる境界（a.md → b.csv）に空行アンカーが入る
		const originalContent = `${[
			"# mdait unit-state — 翻訳ユニットの状態管理",
			"# path\torder\tlevel\ttitleHash\thash\tfrom\tneed",
			"docs/en/a.md\t0\t1\tth0\taaaa\tbbbb\t",
			"docs/en/a.md\t1\t2\tth1\tcccc\tdddd\ttranslate",
			"",
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

	test("path境界に空行アンカーが挿入され、同一path内には挿入されないこと", () => {
		const store = UnitStateStore.getInstance();
		store.load(tempDir);

		// a.md（複数order）→ b.md → c.csv の3グループ
		store.setEntry({ path: "a.md", order: 0, level: 1, titleHash: "h", hash: "a0", from: "f", need: "" });
		store.setEntry({ path: "a.md", order: 1, level: 2, titleHash: "h", hash: "a1", from: "f", need: "" });
		store.setEntry({ path: "b.md", order: 0, level: 1, titleHash: "h", hash: "b0", from: "f", need: "" });
		store.setEntry(plainEntry("c.csv", "c0", "f", "translate"));
		store.save(tempDir);

		const content = fs.readFileSync(path.join(tempDir, "unit-state"), "utf-8");
		const bodyLines = content.split("\n").slice(2); // ヘッダー2行を除く

		// 先頭グループの前には空行が無いこと
		assert.notStrictEqual(bodyLines[0], "");
		// 同一path内（a.md の order 0→1）に空行が無いこと
		assert.ok(bodyLines[0].startsWith("a.md\t0\t"));
		assert.ok(bodyLines[1].startsWith("a.md\t1\t"));
		// path 境界ごとに空行が1行入ること
		const blankCount = bodyLines.filter((l) => l === "").length;
		// a→b, b→c の2境界 + 末尾改行由来の1行 = 3
		assert.strictEqual(blankCount, 3);

		// 空行込みでも再ロードで全エントリが復元されること
		UnitStateStore.dispose();
		const store2 = UnitStateStore.getInstance();
		store2.load(tempDir);
		assert.strictEqual(store2.getAllEntries().length, 4);
	});
});
