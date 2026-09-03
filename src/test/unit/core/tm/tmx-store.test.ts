import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { calculateHash } from "../../../../core/hash/hash-calculator";
import { TmxStore, escapeXml, unescapeXml } from "../../../../core/tm/tmx-store";
import type { TmEntry } from "../../../../core/tm/types";

type TmEntryOverrides = Partial<Pick<TmEntry, "tuid" | "primary" | "weight" | "variants">>;

const SAMPLE_TMX = `<?xml version="1.0" encoding="UTF-8"?>
<tmx version="1.4">
  <body>
    <tu tuid="a1b2c3d4">
      <prop type="x-primary">Download the installer</prop>
      <tuv xml:lang="en">
        <seg>Download the installer</seg>
      </tuv>
      <tuv xml:lang="ja">
        <seg>インストーラーをダウンロード</seg>
      </tuv>
    </tu>
  </body>
</tmx>`;

function createTempFilePath(): string {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tmx-test-"));
	return path.join(tmpDir, "translations.tmx");
}

function createTestEntry(overrides?: TmEntryOverrides): TmEntry {
	const primary = overrides?.primary ?? "Hello world";
	return {
		tuid: overrides?.tuid ?? calculateHash(primary, true),
		primary,
		weight: overrides?.weight ?? 1,
		variants:
			overrides?.variants ??
			new Map([
				["en", { text: primary }],
				["ja", { text: "こんにちは世界" }],
			]),
	};
}

suite("TmxStore", () => {
	let store: TmxStore;
	let tempFilePath: string;

	setup(() => {
		store = new TmxStore();
		tempFilePath = createTempFilePath();
	});

	teardown(() => {
		const dir = path.dirname(tempFilePath);
		if (fs.existsSync(dir)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("XMLエスケープがラウンドトリップする", () => {
		assert.strictEqual(unescapeXml(escapeXml("&<>\"'")), "&<>\"'");
	});

	test("存在しないファイルでは空ストアになる", () => {
		store.load(tempFilePath);
		assert.strictEqual(store.getEntryCount(), 0);
	});

	test("save -> load で tuid/variants を保持できる", () => {
		store.addEntry(createTestEntry());
		store.save(tempFilePath);

		const reloaded = new TmxStore();
		reloaded.load(tempFilePath);
		const entry = reloaded.findByTuid(calculateHash("Hello world", true));
		assert.ok(entry);
		assert.strictEqual(entry.primary, "Hello world");
		assert.strictEqual(entry.variants.get("ja")?.text, "こんにちは世界");
	});

	test("save したTMXに x-source-hash / x-unit / x-unit-hash を出力せず x-wt は出力する", () => {
		store.addEntry(createTestEntry());
		store.save(tempFilePath);

		const xml = fs.readFileSync(tempFilePath, "utf-8");
		assert.strictEqual(xml.includes("x-wt"), true);
		assert.strictEqual(xml.includes("x-source-hash"), false);
		assert.strictEqual(xml.includes("x-unit"), false);
		assert.strictEqual(xml.includes("x-unit-hash"), false);
	});

	test("同一tuidの addEntry は variants をマージする", () => {
		store.addEntry(createTestEntry());
		store.addEntry(
			createTestEntry({
				variants: new Map([["zh-hans", { text: "你好，世界" }]]),
			}),
		);

		assert.strictEqual(
			store.findByTuid(calculateHash("Hello world", true))?.variants.get("zh-hans")?.text,
			"你好，世界",
		);
	});

	test("lookupByHash / lookupBatch は variants から検索できる", () => {
		fs.mkdirSync(path.dirname(tempFilePath), { recursive: true });
		fs.writeFileSync(tempFilePath, SAMPLE_TMX, "utf-8");
		store.load(tempFilePath);

		assert.strictEqual(store.lookupByHash("a1b2c3d4", "en", "ja")?.target, "インストーラーをダウンロード");
		assert.strictEqual(store.lookupBatch(["a1b2c3d4", "missing"], "en", "ja").length, 1);
	});

	test("x-primary が無い旧TMXでも tuid に一致する variant から primary を復元する", () => {
		const legacyTmx = `<?xml version="1.0" encoding="UTF-8"?>
<tmx version="1.4">
  <body>
    <tu tuid="${calculateHash("Download the installer", true)}">
      <tuv xml:lang="ja">
        <seg>インストーラーをダウンロード</seg>
      </tuv>
      <tuv xml:lang="en">
        <seg>Download the installer</seg>
      </tuv>
    </tu>
  </body>
</tmx>`;
		fs.mkdirSync(path.dirname(tempFilePath), { recursive: true });
		fs.writeFileSync(tempFilePath, legacyTmx, "utf-8");

		store.load(tempFilePath);

		assert.strictEqual(
			store.findByTuid(calculateHash("Download the installer", true))?.primary,
			"Download the installer",
		);
		assert.strictEqual(store.findByTuid(calculateHash("Download the installer", true))?.weight, 1);
	});

	test("x-wt がある TMX を読める", () => {
		const weightedTmx = `<?xml version="1.0" encoding="UTF-8"?>
<tmx version="1.4">
  <body>
    <tu tuid="a1b2c3d4">
      <prop type="x-wt">0.250000</prop>
      <tuv xml:lang="en">
        <seg>Download the installer</seg>
      </tuv>
    </tu>
  </body>
</tmx>`;
		fs.mkdirSync(path.dirname(tempFilePath), { recursive: true });
		fs.writeFileSync(tempFilePath, weightedTmx, "utf-8");
		store.load(tempFilePath);
		assert.strictEqual(store.findByTuid("a1b2c3d4")?.weight, 0.25);
	});

	test("x-source-hash が残る旧TMXも通常読込できる", () => {
		const legacyTmx = `<?xml version="1.0" encoding="UTF-8"?>
<tmx version="1.4">
  <body>
    <tu tuid="${calculateHash("Download the installer", true)}">
      <prop type="x-primary">Download the installer</prop>
      <prop type="x-source-hash">legacy-source-hash</prop>
      <tuv xml:lang="en">
        <seg>Download the installer</seg>
      </tuv>
      <tuv xml:lang="ja">
        <seg>インストーラーをダウンロード</seg>
      </tuv>
    </tu>
  </body>
</tmx>`;
		fs.mkdirSync(path.dirname(tempFilePath), { recursive: true });
		fs.writeFileSync(tempFilePath, legacyTmx, "utf-8");

		store.load(tempFilePath);

		const entry = store.findByTuid(calculateHash("Download the installer", true));
		assert.ok(entry);
		assert.strictEqual(entry?.primary, "Download the installer");
		assert.strictEqual(entry?.variants.get("ja")?.text, "インストーラーをダウンロード");
	});

	test("getEntriesByUnitPath が primaryLang を持つ全エントリーを返す", () => {
		store.addEntry(
			createTestEntry({
				primary: "Hello world.",
				variants: new Map([
					["en", { text: "Hello world." }],
					["ja", { text: "こんにちは世界。" }],
				]),
			}),
		);
		store.addEntry(
			createTestEntry({
				tuid: "aaaabbbb",
				primary: "Another sentence.",
				variants: new Map([["en", { text: "Another sentence." }]]),
			}),
		);
		store.addEntry(
			createTestEntry({
				tuid: "ccccdddd",
				primary: "Japanese only.",
				variants: new Map([["ja", { text: "日本語のみ。" }]]),
			}),
		);

		const entries = store.getEntriesByUnitPath("any-path", "en", "ja");
		assert.strictEqual(entries.length, 2);
		assert.ok(entries.some((e) => e.primary === "Hello world."));
		assert.ok(entries.some((e) => e.primary === "Another sentence."));
		assert.ok(!entries.some((e) => e.primary === "Japanese only."));
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

	test("getInstance が同一インスタンスを返す", () => {
		fs.mkdirSync(path.dirname(tempFilePath), { recursive: true });
		fs.writeFileSync(tempFilePath, SAMPLE_TMX, "utf-8");
		assert.strictEqual(TmxStore.getInstance(tempFilePath), TmxStore.getInstance(tempFilePath));
	});
});

suite("TmxStore.findCandidatesByTrigram", () => {
	let store: TmxStore;
	let tempFilePath: string;

	setup(() => {
		store = new TmxStore();
		tempFilePath = createTempFilePath();
	});

	teardown(() => {
		const dir = path.dirname(tempFilePath);
		if (fs.existsSync(dir)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("クエリに trigram が一致するエントリーを返す", () => {
		store.addEntry(
			createTestEntry({
				tuid: "entry1",
				primary: "Download the installer from the website",
				variants: new Map([
					["en", { text: "Download the installer from the website" }],
					["ja", { text: "ウェブサイトからインストーラーをダウンロード" }],
				]),
			}),
		);
		store.addEntry(
			createTestEntry({
				tuid: "entry2",
				primary: "Completely unrelated content xyz",
				variants: new Map([
					["en", { text: "Completely unrelated content xyz" }],
					["ja", { text: "無関係な内容" }],
				]),
			}),
		);

		const results = store.findCandidatesByTrigram("Download the installer", "en");
		assert.ok(results.length > 0);
		// entry1 がヒットすること
		assert.ok(results.some((e) => e.tuid === "entry1"));
	});

	test("クエリが空ストアのとき空配列を返す", () => {
		const results = store.findCandidatesByTrigram("Hello world", "en");
		assert.deepStrictEqual(results, []);
	});

	test("クエリが3文字未満のとき空配列を返す", () => {
		store.addEntry(createTestEntry());
		const results = store.findCandidatesByTrigram("ab", "en");
		assert.deepStrictEqual(results, []);
	});

	test("lang フィルタ: 指定言語の variant を持つエントリーのみ返す", () => {
		store.addEntry(
			createTestEntry({
				tuid: "en-only",
				primary: "Hello world test sentence",
				variants: new Map([["en", { text: "Hello world test sentence" }]]),
			}),
		);
		store.addEntry(
			createTestEntry({
				tuid: "en-ja",
				primary: "Hello world test sentence",
				variants: new Map([
					["en", { text: "Hello world test sentence" }],
					["ja", { text: "こんにちは世界テスト文" }],
				]),
			}),
		);

		const resultsEn = store.findCandidatesByTrigram("Hello world test", "en");
		const resultsFr = store.findCandidatesByTrigram("Hello world test", "fr");

		// en variant を持つ両エントリーが返る
		assert.strictEqual(resultsEn.length, 2);
		// fr variant を持つエントリーはゼロ
		assert.strictEqual(resultsFr.length, 0);
	});

	test("limit を超えて返さない", () => {
		for (let i = 0; i < 10; i++) {
			store.addEntry(
				createTestEntry({
					tuid: `entry${i}`,
					primary: `Hello world test sentence number ${i}`,
					variants: new Map([["en", { text: `Hello world test sentence number ${i}` }]]),
				}),
			);
		}
		const results = store.findCandidatesByTrigram("Hello world test sentence", "en", 3);
		assert.ok(results.length <= 3);
	});

	test("addEntry 後にインデックスが更新される", () => {
		// 最初はヒットなし
		const before = store.findCandidatesByTrigram("New entry text sample", "en");
		assert.strictEqual(before.length, 0);

		store.addEntry(
			createTestEntry({
				tuid: "new1",
				primary: "New entry text sample",
				variants: new Map([["en", { text: "New entry text sample" }]]),
			}),
		);

		const after = store.findCandidatesByTrigram("New entry text sample", "en");
		assert.ok(after.some((e) => e.tuid === "new1"));
	});

	test("load() でインデックスが構築される", () => {
		fs.mkdirSync(path.dirname(tempFilePath), { recursive: true });
		fs.writeFileSync(tempFilePath, SAMPLE_TMX, "utf-8");

		store.load(tempFilePath);

		// SAMPLE_TMX に "Download the installer" が含まれる
		const results = store.findCandidatesByTrigram("Download the installer", "en");
		assert.ok(results.length > 0);
	});

	test("ja クエリで ja variant を検索できる（言語別インデックス）", () => {
		store.addEntry(
			createTestEntry({
				tuid: "bi-lang",
				primary: "Download the installer",
				variants: new Map([
					["en", { text: "Download the installer" }],
					["ja", { text: "インストーラーをダウンロード" }],
				]),
			}),
		);

		// ja クエリは ja インデックスを検索するのでヒットする
		const jaResults = store.findCandidatesByTrigram("インストーラーをダウンロード", "ja");
		assert.ok(jaResults.some((e) => e.tuid === "bi-lang"));

		// en クエリで ja テキストを検索しても en インデックスにないのでヒットしない
		const enWithJaQuery = store.findCandidatesByTrigram("インストーラーをダウンロード", "en");
		assert.strictEqual(enWithJaQuery.length, 0);
	});

	test("clear() 後はインデックスが空になる", () => {
		store.addEntry(
			createTestEntry({
				tuid: "e1",
				primary: "Hello world test sentence",
				variants: new Map([["en", { text: "Hello world test sentence" }]]),
			}),
		);
		store.clear();
		const results = store.findCandidatesByTrigram("Hello world test sentence", "en");
		assert.deepStrictEqual(results, []);
	});

	test("Markdown含む生テキストを渡しても正規化後の候補がヒットする", () => {
		// TM に正規化済みテキストで登録
		store.addEntry(
			createTestEntry({
				tuid: "md-entry",
				primary: "Download the installer package",
				variants: new Map([["en", { text: "Download the installer package" }]]),
			}),
		);

		// 生テキスト（Markdown記法あり）をそのまま渡す
		// findCandidatesByTrigram 内部で normalizeForTm を適用するため一致するはず
		const results = store.findCandidatesByTrigram("Download the **installer** package", "en");
		assert.ok(
			results.some((e) => e.tuid === "md-entry"),
			"Markdown含む生テキストでも候補がヒットすること",
		);
	});
});

suite("TmxStore.getTrigramCache", () => {
	let store: TmxStore;

	setup(() => {
		store = new TmxStore();
	});

	test("addEntry 後にキャッシュが構築される", () => {
		store.addEntry(
			createTestEntry({
				tuid: "cache-entry",
				primary: "Hello cache world",
				variants: new Map([
					["en", { text: "Hello cache world" }],
					["ja", { text: "キャッシュのテスト" }],
				]),
			}),
		);

		const cache = store.getTrigramCache();
		assert.ok(cache.has("cache-entry:en"), 'キャッシュに "cache-entry:en" が存在すること');
		assert.ok(cache.has("cache-entry:ja"), 'キャッシュに "cache-entry:ja" が存在すること');
		assert.ok((cache.get("cache-entry:en")?.size ?? 0) > 0, "en trigram が格納されていること");
	});

	test("clear() 後はキャッシュが空になる", () => {
		store.addEntry(createTestEntry({ tuid: "c1", primary: "Clear test sentence" }));
		store.clear();
		assert.strictEqual(store.getTrigramCache().size, 0);
	});

	test("load() 後にキャッシュが再構築される", () => {
		const tmpDir = require("node:os").tmpdir();
		const tmpPath = require("node:path").join(
			require("node:fs").mkdtempSync(require("node:path").join(tmpDir, "cache-test-")),
			"test.tmx",
		);
		require("node:fs").mkdirSync(require("node:path").dirname(tmpPath), { recursive: true });
		require("node:fs").writeFileSync(tmpPath, SAMPLE_TMX, "utf-8");

		store.load(tmpPath);

		const cache = store.getTrigramCache();
		assert.ok(cache.size > 0, "load 後にキャッシュが構築されること");

		require("node:fs").rmSync(require("node:path").dirname(tmpPath), { recursive: true, force: true });
	});

	test("getTrigramCache の戻り値は ReadonlyMap 型である", () => {
		store.addEntry(createTestEntry({ tuid: "r1", primary: "Readonly test sentence" }));
		const cache = store.getTrigramCache();
		// ReadonlyMap なので set() メソッドが存在しないことを型レベルで保証
		// 実行時テスト: entries() を使って読み取りのみ可能か確認
		let count = 0;
		for (const [_key, trigrams] of cache) {
			count += trigrams.size;
		}
		assert.ok(count > 0, "ReadonlyMap からトリグラムを読み取れること");
	});
});
