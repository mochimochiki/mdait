import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	HELD_ORDER_BASE,
	UnitStateStore,
	isHeldBackEntry,
	isPathInDirs,
	shouldRemoveEntryPath,
} from "../../../core/unit-state/unit-state-store";
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
			configuredDirs: ["ja", "en"],
			scannedDirs: ["ja", "en"],
			seenPaths: new Set(["ja/keep.md"]),
		});

		assert.strictEqual(removed, 2);
		assert.ok(store.getEntry("ja/keep.md", 0));
		assert.strictEqual(store.getEntry("ja/orphan.md", 0), undefined);
		assert.strictEqual(store.getEntry("ja/orphan.md", 1), undefined);
	});

	test("cleanupOrphansInScopeが、configにはあるが今回走査していないディレクトリの行を残すこと", () => {
		const store = UnitStateStore.getInstance();
		store.load(tempDir);

		store.setEntry({ path: "en/guide.md", order: 0, level: 1, titleHash: "h", hash: "1", from: "2", need: "" });
		store.setEntry({ path: "fr/guide.md", order: 0, level: 1, titleHash: "h", hash: "3", from: "4", need: "" });

		// fr は config に載っているが未選択なので走査していない
		const removed = store.cleanupOrphansInScope({
			configuredDirs: ["ja", "en", "fr"],
			scannedDirs: ["ja", "en"],
			seenPaths: new Set(["ja/guide.md", "en/guide.md"]),
		});

		assert.strictEqual(removed, 0);
		assert.ok(store.getEntry("fr/guide.md", 0));
	});

	test("cleanupOrphansInScopeがconfigのどのディレクトリにも属さない行を削除すること", () => {
		const store = UnitStateStore.getInstance();
		store.load(tempDir);

		store.setEntry({ path: "en/guide.md", order: 0, level: 1, titleHash: "h", hash: "1", from: "2", need: "" });
		// ペアを config から外した／ディレクトリを改名した後の旧パス
		store.setEntry({ path: "fr/guide.md", order: 0, level: 1, titleHash: "h", hash: "3", from: "4", need: "" });

		const removed = store.cleanupOrphansInScope({
			configuredDirs: ["ja", "en"],
			scannedDirs: ["ja", "en"],
			seenPaths: new Set(["ja/guide.md", "en/guide.md"]),
		});

		assert.strictEqual(removed, 1);
		assert.strictEqual(store.getEntry("fr/guide.md", 0), undefined);
		assert.ok(store.getEntry("en/guide.md", 0));
	});

	test("cleanupOrphansInScopeがconfiguredDirs空のときは何もしないこと", () => {
		const store = UnitStateStore.getInstance();
		store.load(tempDir);

		store.setEntry({ path: "en/guide.md", order: 0, level: 1, titleHash: "h", hash: "1", from: "2", need: "" });

		const removed = store.cleanupOrphansInScope({
			configuredDirs: [],
			scannedDirs: [],
			seenPaths: new Set<string>(),
		});

		assert.strictEqual(removed, 0);
		assert.ok(store.getEntry("en/guide.md", 0));
	});

	test("cleanupOrphansInScopeが、実体はあるが原文を失った訳文の行を残すこと（孤立訳文）", () => {
		const store = UnitStateStore.getInstance();
		store.load(tempDir);

		// 原文だけリネームされた訳文。原文起点の走査には現れないので seenPaths に入らない
		store.setEntry({ path: "en/guide.md", order: 0, level: 1, titleHash: "h", hash: "1", from: "2", need: "" });
		store.setEntry({ path: "en/gone.md", order: 0, level: 1, titleHash: "h", hash: "3", from: "4", need: "" });

		const removed = store.cleanupOrphansInScope({
			configuredDirs: ["ja", "en"],
			scannedDirs: ["ja", "en"],
			seenPaths: new Set(["ja/guide.md", "en/guide.md"]),
			isOrphanTarget: (filePath) => filePath === "en/gone.md",
		});

		assert.strictEqual(removed, 0);
		assert.ok(store.getEntry("en/gone.md", 0), "孤立を可視化する材料（from / need）が残ること");
	});

	test("cleanupOrphansInScopeが、孤立ではないと答えられた行は従来どおり削除すること", () => {
		const store = UnitStateStore.getInstance();
		store.load(tempDir);

		// trans.extensions を変えて管理対象から外れたファイル。実体はあるが原文も在るので孤立ではない
		store.setEntry({ path: "en/notes.txt", order: 0, level: 0, titleHash: "", hash: "1", from: "2", need: "" });

		const removed = store.cleanupOrphansInScope({
			configuredDirs: ["ja", "en"],
			scannedDirs: ["ja", "en"],
			seenPaths: new Set<string>(),
			isOrphanTarget: () => false,
		});

		assert.strictEqual(removed, 1, "掃除が永久に効かなくなってはいけない");
		assert.strictEqual(store.getEntry("en/notes.txt", 0), undefined);
	});

	test("cleanupOrphansInScopeで孤立判定を渡さなければ従来どおりの挙動になること", () => {
		const store = UnitStateStore.getInstance();
		store.load(tempDir);

		store.setEntry({ path: "en/gone.md", order: 0, level: 1, titleHash: "h", hash: "3", from: "4", need: "" });

		const removed = store.cleanupOrphansInScope({
			configuredDirs: ["ja", "en"],
			scannedDirs: ["ja", "en"],
			seenPaths: new Set<string>(),
		});

		assert.strictEqual(removed, 1);
	});

	test("removeEntriesByPathが保留席も含めて指定パスの行を全部消すこと", () => {
		const store = UnitStateStore.getInstance();
		store.load(tempDir);

		store.setEntry({ path: "en/gone.md", order: 0, level: 1, titleHash: "h", hash: "1", from: "2", need: "" });
		store.setEntry({ path: "en/gone.md", order: HELD_ORDER_BASE, level: 1, titleHash: "h", hash: "3", from: "4", need: "" });
		store.setEntry({ path: "en/keep.md", order: 0, level: 1, titleHash: "h", hash: "5", from: "6", need: "" });

		assert.strictEqual(store.removeEntriesByPath("en/gone.md"), 2);
		assert.strictEqual(store.getEntry("en/gone.md", 0), undefined);
		assert.strictEqual(store.getEntry("en/gone.md", HELD_ORDER_BASE), undefined);
		assert.ok(store.getEntry("en/keep.md", 0));
	});

	test("cleanupOrphansInScopeが名前の先頭が同じ別ディレクトリを範囲内と誤判定しないこと", () => {
		const store = UnitStateStore.getInstance();
		store.load(tempDir);

		store.setEntry({ path: "content/en2/guide.md", order: 0, level: 1, titleHash: "h", hash: "1", from: "", need: "" });

		// content/en2 は content/en の配下ではないので「config 外」＝削除対象になる
		const removed = store.cleanupOrphansInScope({
			configuredDirs: ["content/ja", "content/en"],
			scannedDirs: ["content/ja", "content/en"],
			seenPaths: new Set<string>(),
		});

		assert.strictEqual(removed, 1);
		assert.strictEqual(store.getEntry("content/en2/guide.md", 0), undefined);
	});

	test("isPathInDirsがディレクトリ境界まで見て判定すること", () => {
		assert.strictEqual(isPathInDirs("content/en/a.md", ["content/en"]), true);
		assert.strictEqual(isPathInDirs("content/en/sub/a.md", ["content/en"]), true);
		assert.strictEqual(isPathInDirs("content/en2/a.md", ["content/en"]), false);
		assert.strictEqual(isPathInDirs("content/en/a.md", ["content/en/"]), true);
		assert.strictEqual(isPathInDirs("content/en/a.md", []), false);
		// ワークスペースルート自体が対象なら全てが範囲内
		assert.strictEqual(isPathInDirs("content/en/a.md", [""]), true);
	});

	suite("parkEntries / dropEntries（対応が付かなかった行の保留席）", () => {
		function seed(store: UnitStateStore, count: number): void {
			for (let i = 0; i < count; i++) {
				store.setEntry({
					path: "ja/a.md",
					order: i,
					level: 2,
					titleHash: `t${i}`,
					hash: `h${i}`,
					from: `s${i}`,
					need: "",
				});
			}
		}

		test("末尾でない order を指定して保留席へ移せること", () => {
			const store = UnitStateStore.getInstance();
			store.load(tempDir);
			seed(store, 3);

			assert.strictEqual(store.parkEntries("ja/a.md", [1]), 1);

			const entries = store.getEntriesByPath("ja/a.md");
			assert.deepStrictEqual(
				entries.map((e) => e.order),
				[0, 2, HELD_ORDER_BASE],
			);
			assert.strictEqual(entries[2].hash, "h1", "内容は変わらない");
			assert.strictEqual(entries[2].from, "s1");
		});

		test("既に保留席に居る行と、存在しない order は動かさないこと", () => {
			const store = UnitStateStore.getInstance();
			store.load(tempDir);
			seed(store, 2);
			store.setEntry({
				path: "ja/a.md",
				order: HELD_ORDER_BASE,
				level: 2,
				titleHash: "th",
				hash: "held",
				from: "sh",
				need: "",
			});

			assert.strictEqual(store.parkEntries("ja/a.md", [HELD_ORDER_BASE, 99]), 0);
			assert.strictEqual(store.getEntriesByPath("ja/a.md").length, 3);
		});

		test("同じ本文hashの席は増えず、中身が新しいほうで置き換わること", () => {
			// 席は本文hashの完全一致でしか拾われないので、同じhashの席が2つあっても
			// 片方は永遠に使われない。同じ章を消すたびに席が増えるのを防ぐ
			const store = UnitStateStore.getInstance();
			store.load(tempDir);
			store.setEntry({
				path: "ja/a.md",
				order: HELD_ORDER_BASE,
				level: 2,
				titleHash: "t",
				hash: "same",
				from: "old",
				need: "",
			});
			store.setEntry({ path: "ja/a.md", order: 0, level: 2, titleHash: "t", hash: "same", from: "new", need: "" });

			assert.strictEqual(store.parkEntries("ja/a.md", [0]), 0, "席は増えない");

			const entries = store.getEntriesByPath("ja/a.md");
			assert.strictEqual(entries.length, 1);
			assert.strictEqual(entries[0].order, HELD_ORDER_BASE);
			assert.strictEqual(entries[0].from, "new", "新しいほうが現在に近い");
		});

		test("dropEntries で席の行を外せること", () => {
			const store = UnitStateStore.getInstance();
			store.load(tempDir);
			seed(store, 1);
			store.setEntry({
				path: "ja/a.md",
				order: HELD_ORDER_BASE,
				level: 2,
				titleHash: "t",
				hash: "held",
				from: "s",
				need: "",
			});

			assert.strictEqual(store.dropEntries("ja/a.md", [HELD_ORDER_BASE, 12345]), 1);
			assert.deepStrictEqual(
				store.getEntriesByPath("ja/a.md").map((e) => e.order),
				[0],
			);
		});

		test("countLiveEntriesByPath は席の行を数えないこと", () => {
			const store = UnitStateStore.getInstance();
			store.load(tempDir);
			seed(store, 2);
			store.setEntry({
				path: "ja/a.md",
				order: HELD_ORDER_BASE,
				level: 2,
				titleHash: "t",
				hash: "held",
				from: "s",
				need: "",
			});

			assert.strictEqual(store.countEntriesByPath("ja/a.md"), 3);
			assert.strictEqual(store.countLiveEntriesByPath("ja/a.md"), 2);
		});
	});

	suite("parkEntriesFrom（刈り取りを見送った行の保留席）", () => {
		test("指定order以降の行が保留席へ移り、内容は変わらないこと", () => {
			const store = UnitStateStore.getInstance();
			store.load(tempDir);

			for (let i = 0; i < 4; i++) {
				store.setEntry({
					path: "en/a.md",
					order: i,
					level: 2,
					titleHash: `t${i}`,
					hash: `h${i}`,
					from: `f${i}`,
					need: i === 3 ? "translate" : "",
				});
			}

			const parked = store.parkEntriesFrom("en/a.md", 1);

			assert.strictEqual(parked, 3);
			const entries = store.getEntriesByPath("en/a.md");
			assert.deepStrictEqual(
				entries.map((e) => e.order),
				[0, HELD_ORDER_BASE, HELD_ORDER_BASE + 1, HELD_ORDER_BASE + 2],
			);
			// 内容（hash/from/need）は保たれる
			assert.deepStrictEqual(
				entries.map((e) => `${e.hash}/${e.from}/${e.need}`),
				["h0/f0/", "h1/f1/", "h2/f2/", "h3/f3/translate"],
			);
		});

		test("保留席の行は isHeldBackEntry で見分けられること", () => {
			const store = UnitStateStore.getInstance();
			store.load(tempDir);

			store.setEntry({ path: "en/a.md", order: 0, level: 1, titleHash: "t", hash: "h", from: "f", need: "" });
			store.setEntry({ path: "en/a.md", order: 1, level: 2, titleHash: "t", hash: "h", from: "f", need: "" });
			store.parkEntriesFrom("en/a.md", 1);

			const entries = store.getEntriesByPath("en/a.md");
			assert.deepStrictEqual(entries.map(isHeldBackEntry), [false, true]);
		});

		test("既に保留席にある行は二重に移動せず、席が重ならないこと", () => {
			const store = UnitStateStore.getInstance();
			store.load(tempDir);

			store.setEntry({ path: "en/a.md", order: 0, level: 1, titleHash: "t", hash: "h0", from: "", need: "" });
			store.setEntry({ path: "en/a.md", order: 1, level: 2, titleHash: "t", hash: "h1", from: "", need: "" });
			store.setEntry({ path: "en/a.md", order: 2, level: 2, titleHash: "t", hash: "h2", from: "", need: "" });
			assert.strictEqual(store.parkEntriesFrom("en/a.md", 1), 2);

			// 次の detach でユニットがさらに減った場合（order 0 だけが生きている）
			assert.strictEqual(store.parkEntriesFrom("en/a.md", 1), 0, "生きている行が無ければ何も動かない");
			assert.strictEqual(store.getEntriesByPath("en/a.md").length, 3, "行が失われない");

			// 新たに order 1 が書かれてから、また保留になるケース
			store.setEntry({ path: "en/a.md", order: 1, level: 2, titleHash: "t", hash: "h9", from: "", need: "" });
			assert.strictEqual(store.parkEntriesFrom("en/a.md", 1), 1);
			const orders = store.getEntriesByPath("en/a.md").map((e) => e.order);
			assert.strictEqual(new Set(orders).size, orders.length, "保留席が重ならない");
			assert.strictEqual(orders.length, 4);
		});

		test("移すものが無ければ0を返すこと", () => {
			const store = UnitStateStore.getInstance();
			store.load(tempDir);

			store.setEntry({ path: "en/a.md", order: 0, level: 1, titleHash: "t", hash: "h", from: "", need: "" });

			assert.strictEqual(store.parkEntriesFrom("en/a.md", 1), 0);
			assert.deepStrictEqual(
				store.getEntriesByPath("en/a.md").map((e) => e.order),
				[0],
			);
		});
	});

	suite("shouldRemoveEntryPath（掃除の3分割）", () => {
		const scope = {
			configuredDirs: ["content/ja", "content/en", "content/fr"],
			scannedDirs: ["content/ja", "content/en"],
			seenPaths: new Set(["content/ja/a.md", "content/en/a.md"]),
		};

		test("configのどのディレクトリにも属さない行は消す", () => {
			assert.strictEqual(shouldRemoveEntryPath("content/de/a.md", scope), true);
			assert.strictEqual(shouldRemoveEntryPath("old/a.md", scope), true);
		});

		test("configにはあるが今回走査していない行は残す", () => {
			assert.strictEqual(shouldRemoveEntryPath("content/fr/a.md", scope), false);
		});

		test("走査して見つかった行は残す", () => {
			assert.strictEqual(shouldRemoveEntryPath("content/en/a.md", scope), false);
		});

		test("走査したが見つからなかった行は消す", () => {
			assert.strictEqual(shouldRemoveEntryPath("content/en/gone.txt", scope), true);
		});
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

		test("保留席（HELD_ORDER_BASE以降）の行は削除されないこと", () => {
			// 保留席の order は必ずユニット数より大きいので、範囲で消すと
			// 「ユニット数が元に戻った瞬間に席が全部消える」ことになり、
			// 本文が戻ってくるまで状態を預かるという席の役目が果たせない（ADR-260809-01）
			const store = UnitStateStore.getInstance();
			store.load(tempDir);

			store.setEntry({ path: "ja/a.md", order: 0, level: 2, titleHash: "t", hash: "h", from: "", need: "" });
			store.setEntry({
				path: "ja/a.md",
				order: HELD_ORDER_BASE,
				level: 2,
				titleHash: "t2",
				hash: "h2",
				from: "f",
				need: "",
			});

			const removed = store.pruneEntriesFrom("ja/a.md", 1);

			assert.strictEqual(removed, 0);
			assert.deepStrictEqual(
				store.getEntriesByPath("ja/a.md").map((e) => e.order),
				[0, HELD_ORDER_BASE],
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

	suite("movePath（ファイルの移動への追随）", () => {
		/** MD-external 相当のエントリを生成 */
		function mdEntry(filePath: string, order: number, hash: string, need: string): UnitStateEntry {
			return { path: filePath, order, level: 1, titleHash: `t${order}`, hash, from: `f${order}`, need };
		}

		test("パスに一致する行を新しいパスへ付け替えること", () => {
			const store = UnitStateStore.getInstance();
			store.load(tempDir);
			store.setEntry(mdEntry("content/en/guide.md", 0, "h0", "review"));
			store.setEntry(mdEntry("content/en/guide.md", 1, "h1", ""));

			assert.strictEqual(store.movePath("content/en/guide.md", "content/en/handbook.md"), 2);
			assert.strictEqual(store.countEntriesByPath("content/en/guide.md"), 0);

			const moved = store.getEntriesByPath("content/en/handbook.md");
			assert.strictEqual(moved.length, 2);
			assert.deepStrictEqual(
				moved.map((e) => [e.order, e.hash, e.from, e.need]),
				[
					[0, "h0", "f0", "review"],
					[1, "h1", "f1", ""],
				],
				"order・hash・from・need は移動で変わらないこと",
			);
		});

		test("ディレクトリを動かすと配下の行がまとめて追随すること", () => {
			// フォルダの移動はイベント1件でファイルが何十件も動くため、
			// ファイル単位の呼び出しに割り戻していると取りこぼす
			const store = UnitStateStore.getInstance();
			store.load(tempDir);
			store.setEntry(mdEntry("content/en/sub/a.md", 0, "a0", ""));
			store.setEntry(mdEntry("content/en/sub/deep/b.md", 0, "b0", "translate"));
			store.setEntry(mdEntry("content/en/other.md", 0, "o0", ""));

			assert.strictEqual(store.movePath("content/en/sub", "content/en/moved"), 2);
			assert.strictEqual(store.countEntriesByPath("content/en/moved/a.md"), 1);
			assert.strictEqual(store.countEntriesByPath("content/en/moved/deep/b.md"), 1);
			assert.strictEqual(store.countEntriesByPath("content/en/other.md"), 1, "配下でない行は動かないこと");
		});

		test("前方一致だけの別ファイルを巻き込まないこと", () => {
			const store = UnitStateStore.getInstance();
			store.load(tempDir);
			store.setEntry(mdEntry("content/en/sub-notes.md", 0, "n0", ""));

			assert.strictEqual(store.movePath("content/en/sub", "content/en/moved"), 0);
			assert.strictEqual(store.countEntriesByPath("content/en/sub-notes.md"), 1);
		});

		test("保留席の行も一緒に動かすこと", () => {
			// 保留席は「いまの本文に対応する場所が無い行」の置き場で、移動で失う理由が無い
			const store = UnitStateStore.getInstance();
			store.load(tempDir);
			store.setEntry(mdEntry("content/en/guide.md", 0, "h0", ""));
			store.setEntry(mdEntry("content/en/guide.md", HELD_ORDER_BASE, "held", "review"));

			assert.strictEqual(store.movePath("content/en/guide.md", "content/en/handbook.md"), 2);
			const moved = store.getEntriesByPath("content/en/handbook.md");
			assert.strictEqual(moved.filter((e) => isHeldBackEntry(e)).length, 1);
		});

		test("行き先に残っていた行を消してから移すこと", () => {
			// 移動は上書きであって併合ではない。行き先の余った行を残すと、
			// 次の parse で「余った行」として別の章に拾われる
			const store = UnitStateStore.getInstance();
			store.load(tempDir);
			store.setEntry(mdEntry("content/en/guide.md", 0, "new0", ""));
			store.setEntry(mdEntry("content/en/handbook.md", 0, "old0", ""));
			store.setEntry(mdEntry("content/en/handbook.md", 1, "old1", ""));
			store.setEntry(mdEntry("content/en/handbook.md", 2, "old2", ""));

			assert.strictEqual(store.movePath("content/en/guide.md", "content/en/handbook.md"), 1);
			const moved = store.getEntriesByPath("content/en/handbook.md");
			assert.deepStrictEqual(
				moved.map((e) => e.hash),
				["new0"],
			);
		});

		test("動かす行が無ければ何もしないこと（管理外のファイルの移動）", () => {
			const store = UnitStateStore.getInstance();
			store.load(tempDir);
			store.setEntry(plainEntry("content/en/a.txt", "h", "f", ""));

			assert.strictEqual(store.movePath("README.md", "docs/README.md"), 0);
			assert.strictEqual(store.getAllEntries().length, 1);
		});

		test("同じパスへの移動は何もしないこと", () => {
			const store = UnitStateStore.getInstance();
			store.load(tempDir);
			store.setEntry(mdEntry("content/en/guide.md", 0, "h0", ""));

			assert.strictEqual(store.movePath("content/en/guide.md", "content/en/guide.md"), 0);
			assert.strictEqual(store.countEntriesByPath("content/en/guide.md"), 1);
		});

		test("付け替えた結果が保存され、読み直しても残ること", () => {
			// syncCommand は毎回 load() を無条件に呼ぶため、保存されない付け替えは
			// 次の sync で無言で消える（docs/design/unit-state.md §8）
			const store = UnitStateStore.getInstance();
			store.load(tempDir);
			store.setEntry(mdEntry("content/en/guide.md", 0, "h0", "review"));
			store.movePath("content/en/guide.md", "content/en/handbook.md");
			store.save(tempDir);

			UnitStateStore.dispose();
			const reloaded = UnitStateStore.getInstance();
			reloaded.load(tempDir);
			assert.strictEqual(reloaded.countEntriesByPath("content/en/guide.md"), 0);
			assert.strictEqual(reloaded.getEntry("content/en/handbook.md", 0)?.need, "review");
		});
	});
});
