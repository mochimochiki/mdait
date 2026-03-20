import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { calculateHash } from "../../../core/hash/hash-calculator";
import { TmxStore, escapeXml, unescapeXml } from "../../../core/tm/tmx-store";
import type { TmEntry } from "../../../core/tm/types";

type TmEntryOverrides = Partial<Pick<TmEntry, "tuid" | "primary" | "variants">>;

const SAMPLE_TMX = `<?xml version="1.0" encoding="UTF-8"?>
<tmx version="1.4">
  <body>
    <tu tuid="a1b2c3d4">
      <prop type="x-primary">Download the installer</prop>
      <tuv xml:lang="en">
        <seg>Download the installer</seg>
        <prop type="x-unit">docs/guide.md</prop>
        <prop type="x-unit-hash">unit-en-1</prop>
      </tuv>
      <tuv xml:lang="ja">
        <seg>インストーラーをダウンロード</seg>
        <prop type="x-unit">docs/guide.ja.md</prop>
        <prop type="x-unit-hash">unit-ja-1</prop>
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
		variants:
			overrides?.variants ??
			new Map([
				["en", { text: primary, unitPath: "docs/test.md", unitHash: "en-unit-1" }],
				["ja", { text: "こんにちは世界", unitPath: "docs/test.ja.md", unitHash: "ja-unit-1" }],
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

	test("save したTMXに x-primary / x-source-hash を出力しない", () => {
		store.addEntry(createTestEntry());
		store.save(tempFilePath);

		const xml = fs.readFileSync(tempFilePath, "utf-8");
		assert.strictEqual(xml.includes("x-primary"), false);
		assert.strictEqual(xml.includes("x-source-hash"), false);
	});

	test("同一tuidの addEntry は variants をマージする", () => {
		store.addEntry(createTestEntry());
		store.addEntry(
			createTestEntry({
				variants: new Map([["zh-hans", { text: "你好，世界", unitPath: "docs/test.zh.md", unitHash: "zh-unit-1" }]]),
			}),
		);

		assert.strictEqual(
			store.findByTuid(calculateHash("Hello world", true))?.variants.get("zh-hans")?.text,
			"你好，世界",
		);
	});

	test("getExistingTmSet が primary anchor と localSentence を返す", () => {
		store.addEntry(
			createTestEntry({
				primary: "Hello world.",
				variants: new Map([
					["en", { text: "Hello world.", unitPath: "docs/test.md", unitHash: "en-unit-1" }],
					["ja", { text: "こんにちは世界。", unitPath: "docs/test.ja.md", unitHash: "ja-unit-1" }],
				]),
			}),
		);
		store.addEntry(
			createTestEntry({
				tuid: "22334455",
				primary: "Another sentence.",
				variants: new Map([["en", { text: "Another sentence.", unitPath: "docs/test.md", unitHash: "en-unit-1" }]]),
			}),
		);

		assert.deepStrictEqual(
			store.getExistingTmSet(
				"Hello world. Another sentence.",
				"en",
				"ja",
				"docs/test.md",
				"en-unit-1",
				"こんにちは世界。",
				"docs/test.ja.md",
				"ja-unit-1",
			),
			[
				{ tuid: "22334455", primarySentence: "Another sentence.", localSentence: null },
				{
					tuid: calculateHash("Hello world.", true),
					primarySentence: "Hello world.",
					localSentence: "こんにちは世界。",
				},
			],
		);
	});

	test("getExistingTmSet は同一ファイル内の別ユニットTUを混入させない", () => {
		store.addEntry(
			createTestEntry({
				primary: "Hello world.",
				variants: new Map([
					["en", { text: "Hello world.", unitPath: "docs/test.md", unitHash: "en-unit-1" }],
					["ja", { text: "こんにちは世界。", unitPath: "docs/test.ja.md", unitHash: "ja-unit-1" }],
				]),
			}),
		);
		store.addEntry(
			createTestEntry({
				tuid: "33445566",
				primary: "Separate document sentence.",
				variants: new Map([
					["en", { text: "Separate document sentence.", unitPath: "docs/test.md", unitHash: "en-unit-2" }],
				]),
			}),
		);

		assert.deepStrictEqual(
			store.getExistingTmSet(
				"Hello world.",
				"en",
				"ja",
				"docs/test.md",
				"en-unit-1",
				"こんにちは世界。",
				"docs/test.ja.md",
				"ja-unit-1",
			),
			[
				{
					tuid: calculateHash("Hello world.", true),
					primarySentence: "Hello world.",
					localSentence: "こんにちは世界。",
				},
			],
		);
	});

	test("getExistingTmSet は同一 primary sentence の重複候補でも current primary provenance を優先する", () => {
		store.addEntry(
			createTestEntry({
				tuid: "55667788",
				primary: "Hello world.",
				variants: new Map([
					["en", { text: "Hello world.", unitPath: "docs/test.md", unitHash: "en-unit-1" }],
					["ja", { text: "こんにちは世界。", unitPath: "docs/test.ja.md", unitHash: "ja-unit-1" }],
				]),
			}),
		);
		store.addEntry(
			createTestEntry({
				tuid: "66778899",
				primary: "Hello world.",
				variants: new Map([
					["en", { text: "Hello world.", unitPath: "docs/test.md", unitHash: "en-unit-2" }],
					["ja", { text: "別ユニット訳文。", unitPath: "docs/test.ja.md", unitHash: "ja-unit-2" }],
				]),
			}),
		);

		assert.deepStrictEqual(
			store.getExistingTmSet(
				"Hello world.",
				"en",
				"ja",
				"docs/test.md",
				"en-unit-1",
				"こんにちは世界。",
				"docs/test.ja.md",
				"ja-unit-1",
			),
			[{ tuid: "55667788", primarySentence: "Hello world.", localSentence: "こんにちは世界。" }],
		);
	});

	test("getExistingTmSet は primary hash が変わっても local未登録TUを再利用できる", () => {
		store.addEntry(
			createTestEntry({
				tuid: "44556677",
				primary: "Another sentence.",
				variants: new Map([["en", { text: "Another sentence.", unitPath: "docs/test.md", unitHash: "en-unit-old" }]]),
			}),
		);

		assert.deepStrictEqual(
			store.getExistingTmSet(
				"Another sentence.",
				"en",
				"ja",
				"docs/test.md",
				"en-unit-new",
				"別の文。",
				"docs/test.ja.md",
				"ja-unit-2",
			),
			[{ tuid: "44556677", primarySentence: "Another sentence.", localSentence: null }],
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

	test("getEntriesByUnitPath が primaryLang の unitPath に一致する全エントリーを返す", () => {
		store.addEntry(
			createTestEntry({
				primary: "Hello world.",
				variants: new Map([
					["en", { text: "Hello world.", unitPath: "docs/guide.md", unitHash: "en-unit-1" }],
					["ja", { text: "こんにちは世界。", unitPath: "docs/guide.ja.md", unitHash: "ja-unit-1" }],
				]),
			}),
		);
		store.addEntry(
			createTestEntry({
				tuid: "aaaabbbb",
				primary: "Another sentence.",
				variants: new Map([["en", { text: "Another sentence.", unitPath: "docs/guide.md", unitHash: "en-unit-1" }]]),
			}),
		);
		store.addEntry(
			createTestEntry({
				tuid: "ccccdddd",
				primary: "Unrelated sentence.",
				variants: new Map([["en", { text: "Unrelated sentence.", unitPath: "docs/other.md", unitHash: "en-unit-2" }]]),
			}),
		);

		const entries = store.getEntriesByUnitPath("docs/guide.md", "en", "ja");
		assert.strictEqual(entries.length, 2);
		assert.ok(entries.some((e) => e.primary === "Hello world."));
		assert.ok(entries.some((e) => e.primary === "Another sentence."));
		assert.ok(!entries.some((e) => e.primary === "Unrelated sentence."));
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
