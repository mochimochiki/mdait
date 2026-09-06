import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	FRONT_MATTER_ORDER,
	HELD_ORDER_BASE,
	UnitStateStore,
	isFrontMatterEntry,
	isHeldBackEntry,
	isLiveBodyEntry,
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

	suite("読み直しに割り込まれても、保存していない変更が消えないこと", () => {
		/**
		 * sync は開始直後に load() を無条件に呼び、表を捨ててディスクから読み直す。
		 * その区間に割り込まれた書き手（翻訳・一括変換）の成果がそこで消えると、
		 * 書き手はそのあと save() を呼ぶので**欠けた表がそのまま永続化される**。
		 */
		test("書いてまだ保存していない行が、load() で消えないこと", () => {
			const store = UnitStateStore.getInstance();
			store.load(tempDir);
			store.setEntry(plainEntry("docs/a.md", "h1", "s1", ""));

			// ここで sync が割り込んだ
			store.load(tempDir);

			assert.deepStrictEqual(store.getEntry("docs/a.md", 0)?.hash, "h1");
		});

		test("消した行が、load() でディスクから復活しないこと", () => {
			const store = UnitStateStore.getInstance();
			store.setEntry(plainEntry("docs/a.md", "h1", "s1", ""));
			store.setEntry(plainEntry("docs/b.md", "h2", "s2", ""));
			store.save(tempDir);

			// embedded への一括変換は「本文へ書き戻して行を消す」。保存は最後の1回
			store.removeEntry("docs/a.md", 0);
			store.load(tempDir);

			assert.strictEqual(
				store.getEntry("docs/a.md", 0),
				undefined,
				"消したことを覚えていないと、読み直しで行が戻り本文と二重に持つ",
			);
			assert.strictEqual(store.getEntry("docs/b.md", 0)?.hash, "h2");
		});

		test("割り込みのあいだにディスク側で増えた行も、ちゃんと読めること", () => {
			const store = UnitStateStore.getInstance();
			store.setEntry(plainEntry("docs/a.md", "h1", "s1", ""));
			store.save(tempDir);
			store.setEntry(plainEntry("docs/mine.md", "new", "s9", ""));

			// 別の書き手がディスクへ行を足した状態を作る
			const file = path.join(tempDir, "unit-state");
			fs.appendFileSync(file, "docs/other.md\t0\t0\t\thx\tsx\t\n", "utf-8");
			store.load(tempDir);

			assert.strictEqual(store.getEntry("docs/other.md", 0)?.hash, "hx", "ディスクの行が読めていない");
			assert.strictEqual(store.getEntry("docs/mine.md", 0)?.hash, "new", "自分の未保存の行が消えた");
		});

		test("同じ行がディスクとメモリで食い違ったら、書きかけのメモリを採ること", () => {
			const store = UnitStateStore.getInstance();
			store.setEntry(plainEntry("docs/a.md", "old", "s1", ""));
			store.save(tempDir);
			store.setEntry(plainEntry("docs/a.md", "writing", "s1", ""));

			store.load(tempDir);

			assert.strictEqual(store.getEntry("docs/a.md", 0)?.hash, "writing");
		});

		test("保存し終えた変更は、次の load() で持ち越されないこと", () => {
			const store = UnitStateStore.getInstance();
			store.setEntry(plainEntry("docs/a.md", "h1", "s1", ""));
			store.save(tempDir);

			// 保存済みなので、ディスクを直接書き換えたらそれが正になる
			fs.writeFileSync(path.join(tempDir, "unit-state"), "docs/a.md\t0\t0\t\tfromdisk\ts1\t\n", "utf-8");
			store.load(tempDir);

			assert.strictEqual(
				store.getEntry("docs/a.md", 0)?.hash,
				"fromdisk",
				"保存済みの変更まで当て直すと、外の変更を永久に受け付けなくなる",
			);
		});

		test("一括変換の最中に sync が走っても、変換済みのマーカーが失われないこと", () => {
			const store = UnitStateStore.getInstance();
			store.load(tempDir);

			// 一括変換: 本文からマーカーを剥がしながら行を足していく（保存は最後の1回）
			store.setEntry(plainEntry("docs/a.md", "ha", "sa", ""));
			store.setEntry(plainEntry("docs/b.md", "hb", "sb", ""));

			// ここで利用者が sync を実行した
			store.load(tempDir);

			// 一括変換が残りを処理して保存する
			store.setEntry(plainEntry("docs/c.md", "hc", "sc", ""));
			store.save(tempDir);

			UnitStateStore.dispose();
			const reloaded = UnitStateStore.getInstance();
			reloaded.load(tempDir);
			assert.deepStrictEqual(
				reloaded.getAllEntries().map((e) => e.path).sort(),
				["docs/a.md", "docs/b.md", "docs/c.md"],
				"消えた行のマーカーは本文からも剥がされており、どこにも残らない",
			);
		});

		test("ファイルごと消した行も、読み直しで復活しないこと", () => {
			const store = UnitStateStore.getInstance();
			store.setEntry(plainEntry("docs/a.md", "h1", "s1", ""));
			store.setEntry({ path: "docs/a.md", order: 1, level: 1, titleHash: "t", hash: "h2", from: "s2", need: "" });
			store.save(tempDir);

			store.removeEntriesByPath("docs/a.md");
			store.load(tempDir);

			assert.deepStrictEqual(store.getEntriesByPath("docs/a.md"), []);
		});

		test("付け替えた行の移動元が、読み直しで戻らないこと", () => {
			const store = UnitStateStore.getInstance();
			store.setEntry(plainEntry("docs/old.md", "h1", "s1", ""));
			store.save(tempDir);

			store.movePath("docs/old.md", "docs/new.md");
			store.load(tempDir);

			assert.deepStrictEqual(store.getEntriesByPath("docs/old.md"), [], "移動元の行が復活している");
			assert.strictEqual(store.getEntry("docs/new.md", 0)?.hash, "h1");
		});
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
			fileExists: (filePath: string) => filePath === "en/gone.md",
		});

		assert.strictEqual(removed, 0);
		assert.ok(store.getEntry("en/gone.md", 0), "孤立を可視化する材料（from / need）が残ること");
	});

	test("cleanupOrphansInScopeが、実体のあるファイルの行は管理対象から外れていても残すこと", () => {
		const store = UnitStateStore.getInstance();
		store.load(tempDir);

		// trans.extensions から .txt を外した／ignoredPatterns で除外した、というファイル。
		// 走査の一覧には載らないが「見に行って無かった」のではなく「初めから探していない」。
		// 行を消すと from が失われ、除外を解いた瞬間に人の訳が need:translate へ戻る
		store.setEntry({ path: "en/notes.txt", order: 0, level: 0, titleHash: "", hash: "1", from: "2", need: "" });

		const removed = store.cleanupOrphansInScope({
			configuredDirs: ["ja", "en"],
			scannedDirs: ["ja", "en"],
			seenPaths: new Set<string>(),
			fileExists: (filePath: string) => filePath === "en/notes.txt",
		});

		assert.strictEqual(removed, 0);
		assert.ok(store.getEntry("en/notes.txt", 0), "実体があるあいだは from を持っておく");
	});

	test("cleanupOrphansInScopeが、実体の無いファイルの行は削除すること", () => {
		const store = UnitStateStore.getInstance();
		store.load(tempDir);

		store.setEntry({ path: "en/deleted.md", order: 0, level: 1, titleHash: "h", hash: "1", from: "2", need: "" });

		const removed = store.cleanupOrphansInScope({
			configuredDirs: ["ja", "en"],
			scannedDirs: ["ja", "en"],
			seenPaths: new Set<string>(),
			fileExists: () => false,
		});

		assert.strictEqual(removed, 1, "掃除が永久に効かなくなってはいけない");
		assert.strictEqual(store.getEntry("en/deleted.md", 0), undefined);
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

		test("走査した一覧に無く、実体も無い行は消す", () => {
			assert.strictEqual(shouldRemoveEntryPath("content/en/gone.txt", scope), true);
		});

		test("走査した一覧に無くても、実体があれば残す", () => {
			// ignoredPatterns で外した・trans.extensions から拡張子を外した・原文が消えて
			// 訳文だけ残った（孤立訳文）。どれも「初めから探していない」であって、
			// 「見に行って無かった」ではない（ADR-260810-02）
			const withExists = { ...scope, fileExists: (p: string) => p === "content/en/ignored.md" };
			assert.strictEqual(shouldRemoveEntryPath("content/en/ignored.md", withExists), false);
			assert.strictEqual(shouldRemoveEntryPath("content/en/gone.md", withExists), true);
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

	test("冪等性: 書き出して読み直してまた書き出すと、1バイトも変わらないこと", () => {
		const store = UnitStateStore.getInstance();
		store.load(tempDir);
		store.setEntry({ path: "docs/en/a.md", order: 0, level: 1, titleHash: "th0", hash: "aaaa", from: "bbbb", need: "" });
		store.setEntry({ path: "docs/en/a.md", order: 1, level: 2, titleHash: "th1", hash: "cccc", from: "dddd", need: "translate" });
		store.setEntry(plainEntry("docs/en/b.csv", "eeee", "ffff", ""));
		store.save(tempDir);
		const first = fs.readFileSync(path.join(tempDir, "unit-state"), "utf-8");

		UnitStateStore.dispose();
		const store2 = UnitStateStore.getInstance();
		store2.load(tempDir);
		const entry = store2.getEntry("docs/en/a.md", 0);
		assert.ok(entry);
		store2.setEntry(entry); // 同じ値を入れ直して dirty にする
		store2.save(tempDir);

		assert.strictEqual(fs.readFileSync(path.join(tempDir, "unit-state"), "utf-8"), first);
	});

	test("ファイルごとのブロックが、空行と見出しで挟まれること", () => {
		const store = UnitStateStore.getInstance();
		store.load(tempDir);
		store.setEntry({ path: "d/a.md", order: 0, level: 1, titleHash: "h", hash: "a0", from: "f", need: "" });
		store.setEntry({ path: "d/a.md", order: 1, level: 2, titleHash: "h", hash: "a1", from: "f", need: "" });
		store.setEntry({ path: "d/b.md", order: 0, level: 1, titleHash: "h", hash: "b0", from: "f", need: "" });
		store.save(tempDir);

		const lines = fs.readFileSync(path.join(tempDir, "unit-state"), "utf-8").split("\n");
		const rowIndex = (prefix: string) => lines.findIndex((l) => l.startsWith(prefix));

		// 各ブロックの直前は「空行 → # <path> → 空行」の3行
		for (const filePath of ["d/a.md", "d/b.md"]) {
			const at = rowIndex(`${filePath}\t0\t`);
			assert.ok(at >= 3, `${filePath} のブロックが見つからない`);
			assert.strictEqual(lines[at - 1], "");
			assert.strictEqual(lines[at - 2], `# ${filePath}`);
			assert.strictEqual(lines[at - 3], "");
		}
		// 同じファイルの行のあいだには何も挟まない
		assert.strictEqual(rowIndex("d/a.md\t1\t"), rowIndex("d/a.md\t0\t") + 1);

		// 骨格や見出しが増えても、読み直せば全エントリが戻る
		UnitStateStore.dispose();
		const store2 = UnitStateStore.getInstance();
		store2.load(tempDir);
		assert.strictEqual(store2.getAllEntries().length, 3);
	});

	test("同じディレクトリの2ファイルが、別々の区画に置かれること（同じ場所への追記を避ける）", () => {
		const store = UnitStateStore.getInstance();
		store.load(tempDir);
		store.setEntry(plainEntry("d/n1.md", "x", "f", ""));
		store.setEntry(plainEntry("d/n2.md", "y", "f", ""));
		store.save(tempDir);

		const lines = fs.readFileSync(path.join(tempDir, "unit-state"), "utf-8").split("\n");
		const between = lines.slice(
			lines.findIndex((l) => l.startsWith("d/n1.md\t")),
			lines.findIndex((l) => l.startsWith("d/n2.md\t")),
		);
		// 2つのブロックのあいだに、動かない区画の行が挟まっている
		assert.ok(
			between.some((l) => /^# d\/\[[0-9a-f]{2}\]$/.test(l)),
			`区画の行が挟まっていない: ${JSON.stringify(between)}`,
		);
	});

	suite("合流のあとのファイルを読む", () => {
		const write = (dir: string, lines: string[]) =>
			fs.writeFileSync(path.join(dir, "unit-state"), `${lines.join("\n")}\n`, "utf-8");

		test("同じ席に2行来ても、どちらも捨てないこと", () => {
			write(tempDir, [
				"# mdait unit-state",
				"a.md\t0\t1\tth\thash1\tfrom1\t",
				"a.md\t0\t1\tth\thash2\tfrom2\trevise@old",
			]);
			const store = UnitStateStore.getInstance();
			store.load(tempDir);

			const entries = store.getEntriesByPath("a.md");
			assert.strictEqual(entries.length, 2, "片方が消えている");
			assert.ok(entries.some((e) => e.from === "from1"));
			assert.ok(entries.some((e) => e.from === "from2" && e.need === "revise@old"));
			// 溢れたほうは保留席へ逃がす（位置は持たないが状態は預かる）
			assert.strictEqual(entries.filter((e) => isHeldBackEntry(e)).length, 1);
			assert.strictEqual(store.getLastParseReport().duplicates, 1);
		});

		test("どちらの順で並んでいても、同じ結果になること", () => {
			const rowA = "a.md\t0\t1\tth\thash1\tfrom1\t";
			const rowB = "a.md\t0\t1\tth\thash2\tfrom2\trevise@old";
			const read = (rows: string[]) => {
				const dir = createTempDir();
				write(dir, ["# mdait unit-state", ...rows]);
				UnitStateStore.dispose();
				const store = UnitStateStore.getInstance();
				store.load(dir);
				const seated = store.getEntriesByPath("a.md").map((e) => `${e.order}\t${e.hash}\t${e.from}\t${e.need}`);
				cleanupTempDir(dir);
				return seated.sort();
			};
			assert.deepStrictEqual(read([rowA, rowB]), read([rowB, rowA]));
		});

		test("競合マーカーを読み飛ばし、両陣営の行を拾うこと", () => {
			write(tempDir, [
				"# mdait unit-state",
				"<<<<<<< .mine",
				"a.md\t0\t1\tth\thash1\tfrom1\t",
				"=======",
				"a.md\t0\t1\tth\thash2\tfrom2\trevise@old",
				">>>>>>> .r42",
			]);
			const store = UnitStateStore.getInstance();
			store.load(tempDir);

			assert.strictEqual(store.getEntriesByPath("a.md").length, 2);
			assert.strictEqual(store.getLastParseReport().conflictMarkers, 3);
		});

		test("CRLF のファイルでも need に \\r が混ざらないこと", () => {
			fs.writeFileSync(
				path.join(tempDir, "unit-state"),
				"# mdait unit-state\r\na.md\t0\t1\tth\thash1\tfrom1\t\r\n",
				"utf-8",
			);
			const store = UnitStateStore.getInstance();
			store.load(tempDir);

			const entry = store.getEntry("a.md", 0);
			assert.ok(entry);
			assert.strictEqual(entry.need, "", "need に \\r が残っている");
			assert.strictEqual(store.getLastParseReport().skipped, 0);
		});

		test("傷があった回は、上書きの前に原本を横へ写すこと", () => {
			write(tempDir, [
				"# mdait unit-state",
				"a.md\t0\t1\tth\thash1\tfrom1\t",
				"a.md\t0\t1\tth\thash2\tfrom2\trevise@old",
			]);
			const original = fs.readFileSync(path.join(tempDir, "unit-state"), "utf-8");

			const store = UnitStateStore.getInstance();
			store.load(tempDir);
			store.save(tempDir); // 傷があった回は dirty が立つので書き戻る

			const salvaged = path.join(tempDir, "unit-state.broken");
			assert.ok(fs.existsSync(salvaged), "原本が写されていない");
			assert.strictEqual(fs.readFileSync(salvaged, "utf-8"), original);
		});

		test("傷が無い回は、原本を写さないこと", () => {
			write(tempDir, ["# mdait unit-state", "a.md\t0\t1\tth\thash1\tfrom1\t"]);
			const store = UnitStateStore.getInstance();
			store.load(tempDir);
			const entry = store.getEntry("a.md", 0);
			assert.ok(entry);
			store.setEntry(entry);
			store.save(tempDir);

			assert.ok(!fs.existsSync(path.join(tempDir, "unit-state.broken")));
		});

		test("既にある避難先は上書きしないこと（最初の事故の姿を残す）", () => {
			fs.writeFileSync(path.join(tempDir, "unit-state.broken"), "最初の事故", "utf-8");
			write(tempDir, [
				"# mdait unit-state",
				"a.md\t0\t1\tth\thash1\tfrom1\t",
				"a.md\t0\t1\tth\thash2\tfrom2\t",
			]);
			const store = UnitStateStore.getInstance();
			store.load(tempDir);
			store.save(tempDir);

			assert.strictEqual(fs.readFileSync(path.join(tempDir, "unit-state.broken"), "utf-8"), "最初の事故");
		});
	});

	suite("行の持ち方（path → order の二段）", () => {
		test("ファイル単位の読み出しが、他のファイルの行数に影響されないこと", () => {
			// ワークスペース全体の行数に比例して重くならないことの、挙動としての最小確認。
			// （速さそのものは測らない。ここで固定するのは「他所の行が混ざらない」こと）
			const store = UnitStateStore.getInstance();
			store.load(tempDir);

			for (let f = 0; f < 50; f++) {
				for (let o = 0; o < 5; o++) {
					store.setEntry({
						path: `content/en/f${f}.md`,
						order: o,
						level: 2,
						titleHash: "t",
						hash: `h${f}_${o}`,
						from: "s",
						need: "",
					});
				}
			}

			assert.strictEqual(store.getAllEntries().length, 250);
			assert.strictEqual(store.countEntriesByPath("content/en/f7.md"), 5);
			assert.deepStrictEqual(
				store.getEntriesByPath("content/en/f7.md").map((e) => e.hash),
				["h7_0", "h7_1", "h7_2", "h7_3", "h7_4"],
			);
			assert.strictEqual(store.countEntriesByPath("content/en/nothing.md"), 0);
			assert.deepStrictEqual(store.getEntriesByPath("content/en/nothing.md"), []);
		});

		test("入れ子のディレクトリへ移しても、行が二重にならないこと", () => {
			// 移動元と行き先が重なる形。取り出してから置き直す順序を間違えると、
			// 行き先を消す段で「いま動かした行」を巻き込む
			const store = UnitStateStore.getInstance();
			store.load(tempDir);

			store.setEntry({ path: "content/en/a.md", order: 0, level: 2, titleHash: "t", hash: "h1", from: "", need: "" });
			store.setEntry({
				path: "content/en/sub/b.md",
				order: 0,
				level: 2,
				titleHash: "t",
				hash: "h2",
				from: "",
				need: "",
			});

			const moved = store.movePath("content/en", "content/en/sub");

			assert.strictEqual(moved, 2);
			assert.deepStrictEqual(
				store
					.getAllEntries()
					.map((e) => e.path)
					.sort(),
				["content/en/sub/a.md", "content/en/sub/sub/b.md"],
			);
		});
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

	suite("行の種別（本文・保留席・frontmatter）の見分け", () => {
		const rel = "content/en/guide.md";

		function bodyEntry(order: number): UnitStateEntry {
			return { path: rel, order, level: 1, titleHash: "t", hash: `h${order}`, from: "f", need: "" };
		}

		test("frontmatter の行は本文の行でも保留席でもないこと", () => {
			const fm: UnitStateEntry = {
				path: rel,
				order: FRONT_MATTER_ORDER,
				level: 0,
				titleHash: "",
				hash: "fh",
				from: "sf",
				need: "",
			};
			assert.strictEqual(isFrontMatterEntry(fm), true);
			assert.strictEqual(isHeldBackEntry(fm), false, "保留席より上だが席ではない");
			assert.strictEqual(isLiveBodyEntry(fm), false, "本文の位置を持たない");
		});

		test("保留席の行は本文の行ではないこと", () => {
			const held: UnitStateEntry = {
				path: rel,
				order: HELD_ORDER_BASE,
				level: 1,
				titleHash: "t",
				hash: "hh",
				from: "f",
				need: "",
			};
			assert.strictEqual(isHeldBackEntry(held), true);
			assert.strictEqual(isLiveBodyEntry(held), false, "意味は持つが位置は持たない");
			assert.strictEqual(isFrontMatterEntry(held), false);
		});

		test("countBodyEntriesByPath が frontmatter の行を数えないこと", () => {
			// 「訳文に守るべき状態が残っているか」を全行で数えると、frontmatter しか
			// 持たない訳文が常に1以上になり、原文にあとから足した章が永久に現れなくなる
			const store = UnitStateStore.getInstance();
			store.load(tempDir);
			store.setFrontMatterEntry(rel, { hash: "fh", from: "sf", need: "translate" });

			assert.strictEqual(store.countEntriesByPath(rel), 1, "全行では1");
			assert.strictEqual(store.countBodyEntriesByPath(rel), 0, "本文の行は0");
			assert.strictEqual(store.countLiveEntriesByPath(rel), 0);
		});

		test("countBodyEntriesByPath は保留席を数に入れ、countLiveEntriesByPath は入れないこと", () => {
			// 席の行は「消えた章の from / need を預かっている」＝守るべき状態そのものなので、
			// 状態の有無を問うときは数える。位置の話（末尾を刈るか）のときだけ外す
			const store = UnitStateStore.getInstance();
			store.load(tempDir);
			store.setEntry(bodyEntry(0));
			store.setEntry(bodyEntry(1));
			store.setFrontMatterEntry(rel, { hash: "fh", from: "sf", need: "" });
			store.parkEntries(rel, [1]);

			assert.strictEqual(store.countEntriesByPath(rel), 3, "本文1 + 席1 + frontmatter1");
			assert.strictEqual(store.countBodyEntriesByPath(rel), 2, "本文1 + 席1");
			assert.strictEqual(store.countLiveEntriesByPath(rel), 1, "本文1のみ");
		});
	});
});
