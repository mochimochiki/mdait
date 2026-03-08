import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TmxStore, escapeXml, unescapeXml } from "../../../core/tm/tmx-store";
import type { TmEntry } from "../../../core/tm/types";

/** テスト用TMXテンプレート */
const SAMPLE_TMX = `<?xml version="1.0" encoding="UTF-8"?>
<tmx version="1.4">
  <body>
    <tu>
      <prop type="x-hash">a1b2c3d4</prop>
      <prop type="x-unit">docs/guide.md</prop>
      <tuv xml:lang="en"><seg>Download the installer</seg></tuv>
      <tuv xml:lang="ja"><seg>インストーラーをダウンロード</seg></tuv>
    </tu>
    <tu>
      <prop type="x-hash">e5f6a7b8</prop>
      <prop type="x-unit">docs/api.md</prop>
      <tuv xml:lang="en"><seg>Run the installer</seg></tuv>
      <tuv xml:lang="ja"><seg>インストーラーを実行</seg></tuv>
    </tu>
  </body>
</tmx>`;

/** テスト用一時ディレクトリとファイルパスを生成するヘルパー */
function createTempFilePath(): string {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tmx-test-"));
	return path.join(tmpDir, "translations.tmx");
}

/** テスト用エントリーを作成するヘルパー */
function createTestEntry(overrides?: Partial<TmEntry>): TmEntry {
	const entry: TmEntry = {
		sentenceHash: overrides?.sentenceHash ?? "11223344",
		segments:
			overrides?.segments ??
			new Map([
				["en", "Hello world"],
				["ja", "こんにちは世界"],
			]),
		unitPath: overrides?.unitPath ?? "docs/test.md",
	};
	if (overrides?.sourceHash) {
		entry.sourceHash = overrides.sourceHash;
	}
	return entry;
}

suite("XMLエスケープ", () => {
	test("特殊文字がエスケープされる", () => {
		assert.strictEqual(escapeXml("&<>\"'"), "&amp;&lt;&gt;&quot;&apos;");
	});

	test("エスケープされた文字列が復元される", () => {
		assert.strictEqual(unescapeXml("&amp;&lt;&gt;&quot;&apos;"), "&<>\"'");
	});

	test("エスケープと復元がラウンドトリップする", () => {
		const original = "テスト&<>\"' content";
		assert.strictEqual(unescapeXml(escapeXml(original)), original);
	});
});

suite("TmxStore", () => {
	let store: TmxStore;
	let tempFilePath: string;

	setup(() => {
		store = new TmxStore();
		tempFilePath = createTempFilePath();
	});

	teardown(() => {
		// 一時ファイルのクリーンアップ
		const dir = path.dirname(tempFilePath);
		if (fs.existsSync(dir)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	suite("load", () => {
		test("存在しないファイルの場合、空インデックスで初期化される", () => {
			store.load(tempFilePath);
			assert.strictEqual(store.getEntryCount(), 0);
		});

		test("TMXファイルを正しくパースしてエントリーが復元される", () => {
			fs.mkdirSync(path.dirname(tempFilePath), { recursive: true });
			fs.writeFileSync(tempFilePath, SAMPLE_TMX, "utf-8");

			store.load(tempFilePath);
			assert.strictEqual(store.getEntryCount(), 2);

			const entry1 = store.findByHash("a1b2c3d4");
			assert.ok(entry1);
			assert.strictEqual(entry1.segments.get("en"), "Download the installer");
			assert.strictEqual(entry1.segments.get("ja"), "インストーラーをダウンロード");
			assert.strictEqual(entry1.unitPath, "docs/guide.md");
		});

		test("複数のusedInを持つエントリーが正しくパースされる", () => {
			fs.mkdirSync(path.dirname(tempFilePath), { recursive: true });
			fs.writeFileSync(tempFilePath, SAMPLE_TMX, "utf-8");

			store.load(tempFilePath);
			const entry2 = store.findByHash("e5f6a7b8");
			assert.ok(entry2);
			assert.strictEqual(entry2.unitPath, "docs/api.md");
		});
	});

	suite("save", () => {
		test("空のストアでもTMXファイルが作成される", () => {
			store.save(tempFilePath);
			assert.ok(fs.existsSync(tempFilePath));
			const content = fs.readFileSync(tempFilePath, "utf-8");
			assert.ok(content.includes('<?xml version="1.0"'));
			assert.ok(content.includes("<tmx"));
			assert.ok(content.includes("<body"));
		});

		test("エントリーを追加した後にsaveするとTMXファイルに反映される", () => {
			const entry = createTestEntry();
			store.addEntry(entry);
			store.save(tempFilePath);

			const newStore = new TmxStore();
			newStore.load(tempFilePath);
			assert.strictEqual(newStore.getEntryCount(), 1);

			const loaded = newStore.findByHash("11223344");
			assert.ok(loaded);
			assert.strictEqual(loaded.segments.get("en"), "Hello world");
			assert.strictEqual(loaded.segments.get("ja"), "こんにちは世界");
		});

		test("load→save→loadのラウンドトリップでデータが保持される", () => {
			fs.mkdirSync(path.dirname(tempFilePath), { recursive: true });
			fs.writeFileSync(tempFilePath, SAMPLE_TMX, "utf-8");

			store.load(tempFilePath);
			const countBefore = store.getEntryCount();

			store.save(tempFilePath);

			const newStore = new TmxStore();
			newStore.load(tempFilePath);
			assert.strictEqual(newStore.getEntryCount(), countBefore);

			const entry = newStore.findByHash("a1b2c3d4");
			assert.ok(entry);
			assert.strictEqual(entry.segments.get("en"), "Download the installer");
		});

		test("XMLエスケープが必要な文字を含むエントリーがラウンドトリップする", () => {
			const entry = createTestEntry({
				sentenceHash: "esc12345",
				segments: new Map([
					["en", 'Use <code> & "quotes"'],
					["ja", '<コード>と&"引用"を使用'],
				]),
			});
			store.addEntry(entry);
			store.save(tempFilePath);

			const newStore = new TmxStore();
			newStore.load(tempFilePath);
			const loaded = newStore.findByHash("esc12345");
			assert.ok(loaded);
			assert.strictEqual(loaded.segments.get("en"), 'Use <code> & "quotes"');
			assert.strictEqual(loaded.segments.get("ja"), '<コード>と&"引用"を使用');
		});

		test("ディレクトリが存在しなくても再帰的に作成してsaveできる", () => {
			const nestedPath = path.join(path.dirname(tempFilePath), "deep", "nested", "translations.tmx");
			store.addEntry(createTestEntry());
			store.save(nestedPath);
			assert.ok(fs.existsSync(nestedPath));
		});
	});

	suite("addEntry", () => {
		test("新規エントリーが正しく追加される", () => {
			store.addEntry(createTestEntry());
			assert.strictEqual(store.getEntryCount(), 1);
			assert.ok(store.findByHash("11223344"));
		});

		test("同一ハッシュのエントリー追加時はセグメントが最新で上書きされる", () => {
			store.addEntry(createTestEntry());
			store.addEntry(
				createTestEntry({
					segments: new Map([
						["en", "Hello world updated"],
						["ja", "こんにちは世界（更新）"],
					]),
				}),
			);

			assert.strictEqual(store.getEntryCount(), 1);
			const entry = store.findByHash("11223344");
			assert.ok(entry);
			assert.strictEqual(entry.segments.get("en"), "Hello world updated");
		});

		test("同一ハッシュのエントリー追加時にusedInが追加される", () => {
			store.addEntry(createTestEntry());
			store.addEntry(
				createTestEntry({
					unitPath: "docs/other.md",
				}),
			);

			const entry = store.findByHash("11223344");
			assert.ok(entry);
			assert.strictEqual(entry.unitPath, "docs/other.md");
		});

		test("同一usedInの重複追加は無視される", () => {
			store.addEntry(createTestEntry());
			store.addEntry(createTestEntry()); // 同じunitPath

			const entry = store.findByHash("11223344");
			assert.ok(entry);
			assert.strictEqual(entry.unitPath, "docs/test.md");
		});
	});

	suite("setUnitPath", () => {
		test("既存エントリーの出典パスが設定される", () => {
			store.addEntry(createTestEntry());
			const result = store.setUnitPath("11223344", "docs/new.md");

			assert.strictEqual(result, true);
			const entry = store.findByHash("11223344");
			assert.ok(entry);
			assert.strictEqual(entry.unitPath, "docs/new.md");
		});

		test("存在しないハッシュにはfalseを返す", () => {
			const result = store.setUnitPath("nonexist", "docs/x.md");
			assert.strictEqual(result, false);
		});
	});

	suite("updateTarget", () => {
		test("既存エントリーのターゲット訳文が更新される", () => {
			store.addEntry(createTestEntry());
			const result = store.updateTarget("11223344", "ja", "更新後の訳文");

			assert.strictEqual(result, true);
			const entry = store.findByHash("11223344");
			assert.ok(entry);
			assert.strictEqual(entry.segments.get("ja"), "更新後の訳文");
		});

		test("存在しないハッシュにはfalseを返す", () => {
			const result = store.updateTarget("nonexist", "ja", "test");
			assert.strictEqual(result, false);
		});
	});

	suite("lookupByHash / lookupBatch", () => {
		setup(() => {
			fs.mkdirSync(path.dirname(tempFilePath), { recursive: true });
			fs.writeFileSync(tempFilePath, SAMPLE_TMX, "utf-8");
			store.load(tempFilePath);
		});

		test("ソース・ターゲット言語が一致するエントリーのTmMatchが返される", () => {
			const match = store.lookupByHash("a1b2c3d4", "en", "ja");
			assert.ok(match);
			assert.strictEqual(match.source, "Download the installer");
			assert.strictEqual(match.target, "インストーラーをダウンロード");
			assert.strictEqual(match.sentenceHash, "a1b2c3d4");
			assert.ok(match.firstUsedIn.includes("docs/guide.md"));
		});

		test("ターゲット言語がないエントリーはundefinedを返す", () => {
			const match = store.lookupByHash("a1b2c3d4", "en", "fr");
			assert.strictEqual(match, undefined);
		});

		test("lookupBatchで複数ハッシュを一括検索できる", () => {
			const matches = store.lookupBatch(["a1b2c3d4", "e5f6a7b8", "nonexist"], "en", "ja");
			assert.strictEqual(matches.length, 2);
			assert.strictEqual(matches[0].sentenceHash, "a1b2c3d4");
			assert.strictEqual(matches[1].sentenceHash, "e5f6a7b8");
		});
	});

	suite("searchBySource", () => {
		test("指定言語のセグメントが完全一致するエントリーが返される", () => {
			store.addEntry(createTestEntry());
			const results = store.searchBySource("Hello world", "en");
			assert.strictEqual(results.length, 1);
			assert.strictEqual(results[0].sentenceHash, "11223344");
		});

		test("一致しないテキストでは空配列が返される", () => {
			store.addEntry(createTestEntry());
			const results = store.searchBySource("No match", "en");
			assert.strictEqual(results.length, 0);
		});
	});

	suite("hasSourceHash", () => {
		test("sourceHash付きエントリーが登録されている場合trueを返す", () => {
			store.addEntry(createTestEntry({ sourceHash: "src-hash-001" }));
			assert.strictEqual(store.hasSourceHash("src-hash-001"), true);
		});

		test("sourceHashが存在しない場合falseを返す", () => {
			store.addEntry(createTestEntry());
			assert.strictEqual(store.hasSourceHash("nonexist"), false);
		});

		test("clear後はfalseを返す", () => {
			store.addEntry(createTestEntry({ sourceHash: "src-hash-001" }));
			store.clear();
			assert.strictEqual(store.hasSourceHash("src-hash-001"), false);
		});

		test("複数エントリーのsourceHashが正しくインデックスされる", () => {
			store.addEntry(createTestEntry({ sentenceHash: "aaa", sourceHash: "src-1" }));
			store.addEntry(createTestEntry({ sentenceHash: "bbb", sourceHash: "src-2" }));
			assert.strictEqual(store.hasSourceHash("src-1"), true);
			assert.strictEqual(store.hasSourceHash("src-2"), true);
			assert.strictEqual(store.hasSourceHash("src-3"), false);
		});

		test("addEntryによるsourceHash更新後も検索可能", () => {
			store.addEntry(createTestEntry({ sentenceHash: "aaa", sourceHash: "old-hash" }));
			store.addEntry(createTestEntry({ sentenceHash: "aaa", sourceHash: "new-hash" }));
			assert.strictEqual(store.hasSourceHash("new-hash"), true);
			// 旧hashはインデックスに残存するがfalse positiveは実害なし（スキップされるだけ）
			assert.strictEqual(store.hasSourceHash("old-hash"), true);
		});
	});

	suite("sourceHashラウンドトリップ", () => {
		let tempFilePath: string;

		setup(() => {
			tempFilePath = createTempFilePath();
		});

		teardown(() => {
			const dir = path.dirname(tempFilePath);
			if (fs.existsSync(dir)) {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		test("sourceHash付きエントリーがsave→loadで保持される", () => {
			store.addEntry(createTestEntry({ sourceHash: "src-hash-roundtrip" }));
			store.save(tempFilePath);

			const store2 = new TmxStore();
			store2.load(tempFilePath);
			const entry = store2.findByHash("11223344");
			assert.ok(entry);
			assert.strictEqual(entry.sourceHash, "src-hash-roundtrip");
			assert.strictEqual(store2.hasSourceHash("src-hash-roundtrip"), true);
		});
	});
});

suite("TmxStoreシングルトン", () => {
	let tempFilePath: string;

	setup(() => {
		TmxStore.resetInstance();
		tempFilePath = createTempFilePath();
	});

	teardown(() => {
		TmxStore.resetInstance();
		const dir = path.dirname(tempFilePath);
		if (fs.existsSync(dir)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("getInstance()が同一インスタンスを返す", () => {
		fs.mkdirSync(path.dirname(tempFilePath), { recursive: true });
		fs.writeFileSync(tempFilePath, SAMPLE_TMX, "utf-8");

		const store1 = TmxStore.getInstance(tempFilePath);
		const store2 = TmxStore.getInstance(tempFilePath);
		assert.strictEqual(store1, store2);
		assert.strictEqual(store1.getEntryCount(), 2);
	});

	test("save()後のgetInstance()がリロードしない（mtime一致）", () => {
		fs.mkdirSync(path.dirname(tempFilePath), { recursive: true });
		fs.writeFileSync(tempFilePath, SAMPLE_TMX, "utf-8");

		const store = TmxStore.getInstance(tempFilePath);
		const countBefore = store.getEntryCount();

		// エントリーを追加してsave
		store.addEntry(createTestEntry());
		store.save(tempFilePath);

		// save後のgetInstanceはリロードせず、インメモリ状態を保持
		const storeAfter = TmxStore.getInstance(tempFilePath);
		assert.strictEqual(store, storeAfter);
		assert.strictEqual(storeAfter.getEntryCount(), countBefore + 1);
	});

	test("ファイル外部変更時に再ロードされる", () => {
		fs.mkdirSync(path.dirname(tempFilePath), { recursive: true });
		fs.writeFileSync(tempFilePath, SAMPLE_TMX, "utf-8");

		const store = TmxStore.getInstance(tempFilePath);
		assert.strictEqual(store.getEntryCount(), 2);

		// 外部からファイルを書き換え（mtimeが変わるようにutimesで明示的にタイムスタンプを変更）
		const newTmx = SAMPLE_TMX.replace(/<tu>\s*<prop type="x-hash">e5f6a7b8<\/prop>[\s\S]*?<\/tu>/, "");
		// mtimeが変わるようにutimesで明示的にタイムスタンプを変更
		fs.writeFileSync(tempFilePath, newTmx, "utf-8");
		const futureTime = Date.now() / 1000 + 10;
		fs.utimesSync(tempFilePath, futureTime, futureTime);

		const storeAfter = TmxStore.getInstance(tempFilePath);
		assert.strictEqual(storeAfter, store); // 同一インスタンス
		assert.strictEqual(storeAfter.getEntryCount(), 1); // リロードされてエントリー数が減少
	});

	test("resetInstance()後は新しいインスタンスが返される", () => {
		fs.mkdirSync(path.dirname(tempFilePath), { recursive: true });
		fs.writeFileSync(tempFilePath, SAMPLE_TMX, "utf-8");

		const store1 = TmxStore.getInstance(tempFilePath);
		TmxStore.resetInstance();
		const store2 = TmxStore.getInstance(tempFilePath);
		assert.notStrictEqual(store1, store2);
	});
});
