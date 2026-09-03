/**
 * asset-copier.ts のユニットテスト
 */

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MarkdownAssetPathExtractor, copyDiffAssets, resolveCopyAssets } from "../../../../commands/sync/asset-copier";
import { DiffType, type UnitDiff } from "../../../../commands/sync/diff-detector";
import { MdaitMarker } from "../../../../core/markdown/mdait-marker";
import { MdaitUnit } from "../../../../core/markdown/mdait-unit";
import type { Configuration } from "../../../../infra/config/configuration";

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

function makeUnit(hash: string, content: string, need: string | null = null, from: string | null = null): MdaitUnit {
	return new MdaitUnit(new MdaitMarker(hash, from, need), "title", 1, content);
}

function makeAddedDiff(content: string): UnitDiff {
	return {
		type: DiffType.ADDED,
		source: makeUnit("hash1", content),
		target: null,
	};
}

// ---------------------------------------------------------------------------
// MarkdownAssetPathExtractor
// ---------------------------------------------------------------------------

suite("MarkdownAssetPathExtractor.extractPaths()", () => {
	let extractor: MarkdownAssetPathExtractor;

	setup(() => {
		extractor = new MarkdownAssetPathExtractor();
	});

	test("画像パス ![alt](./img.png) が抽出される", () => {
		const result = extractor.extractPaths("![alt](./img.png)");
		assert.deepStrictEqual(result, ["./img.png"]);
	});

	test("リンクパス [text](./file.csv) が抽出される", () => {
		const result = extractor.extractPaths("[text](./file.csv)");
		assert.deepStrictEqual(result, ["./file.csv"]);
	});

	test("画像・リンクが複数ある場合、すべて抽出される", () => {
		const content = "![a](./a.png) some text [b](./b.csv) ![c](./c.jpg)";
		const result = extractor.extractPaths(content);
		// 画像を先に収集してからリンクを収集する実装順
		assert.deepStrictEqual(result, ["./a.png", "./c.jpg", "./b.csv"]);
	});

	test("外部URLも抽出される（フィルタリングはextractor外）", () => {
		const result = extractor.extractPaths("![img](http://example.com/img.png)");
		assert.deepStrictEqual(result, ["http://example.com/img.png"]);
	});

	test('タイトル属性 "title" が除かれてパスのみ抽出される', () => {
		const result = extractor.extractPaths('![alt](./img.png "title")');
		assert.deepStrictEqual(result, ["./img.png"]);
	});

	test("空文字列のとき空配列を返す", () => {
		const result = extractor.extractPaths("");
		assert.deepStrictEqual(result, []);
	});

	test("リンクがないとき空配列を返す", () => {
		const result = extractor.extractPaths("This is plain text without links.");
		assert.deepStrictEqual(result, []);
	});
});

// ---------------------------------------------------------------------------
// resolveCopyAssets — 純粋関数の挙動
// ---------------------------------------------------------------------------

suite("resolveCopyAssets()", () => {
	test("global=true / pair=undefined → 全コピー（whitelistなし）", () => {
		const result = resolveCopyAssets(undefined, true);
		assert.deepStrictEqual(result, { whitelist: null });
	});

	test("global=false / pair=undefined → null（無効）", () => {
		assert.strictEqual(resolveCopyAssets(undefined, false), null);
	});

	test("pair優先: global=true でも pair=false なら null", () => {
		assert.strictEqual(resolveCopyAssets(false, true), null);
	});

	test("pair優先: global=false でも pair=true なら全コピー", () => {
		assert.deepStrictEqual(resolveCopyAssets(true, false), { whitelist: null });
	});

	test("global=string[] → 拡張子ホワイトリスト（小文字化）", () => {
		const result = resolveCopyAssets(undefined, [".PNG", ".JPG"]);
		assert.ok(result !== null);
		assert.ok(result.whitelist?.has(".png"));
		assert.ok(result.whitelist?.has(".jpg"));
		assert.strictEqual(result.whitelist?.size, 2);
	});

	test("空配列は無効扱い", () => {
		assert.strictEqual(resolveCopyAssets(undefined, []), null);
		assert.strictEqual(resolveCopyAssets([], true), null);
	});

	test("pair優先: global=true でも pair=[] なら無効", () => {
		assert.strictEqual(resolveCopyAssets([], true), null);
	});

	test('pair優先: global=[] でも pair=[".png"] ならホワイトリスト', () => {
		const result = resolveCopyAssets([".png"], []);
		assert.ok(result !== null);
		assert.ok(result.whitelist?.has(".png"));
	});
});

// ---------------------------------------------------------------------------
// copyDiffAssets — ファイルシステムを使った統合テスト
// ---------------------------------------------------------------------------

suite("copyDiffAssets()", () => {
	let tmpBaseDir: string;
	let absoluteSourceDir: string;
	let absoluteTargetDir: string;
	let sourceFile: string;
	let mockConfig: Configuration;
	let mockLoadOldSource: (hash: string) => Promise<string | null>;

	/** テストごとに oldhash → 旧原文 content のマッピングを張る */
	let oldSourceMap: Map<string, string>;

	setup(() => {
		tmpBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-asset-copier-"));
		absoluteSourceDir = path.join(tmpBaseDir, "src");
		absoluteTargetDir = path.join(tmpBaseDir, "ja");
		// sourceFile は absoluteSourceDir 直下に置く（srcFileDir = absoluteSourceDir）
		sourceFile = path.join(absoluteSourceDir, "test.md");

		fs.mkdirSync(absoluteSourceDir, { recursive: true });
		fs.mkdirSync(absoluteTargetDir, { recursive: true });

		mockConfig = {
			getTransPairForSourceFile: (_: string) => ({
				sourceDir: "src",
				targetDir: "ja",
				sourceLang: "en",
				targetLang: "ja",
				copyAssets: true,
			}),
			getConfigBaseDir: () => tmpBaseDir,
			sync: { copyAssets: true },
			trans: { extensions: [] },
		} as unknown as Configuration;

		oldSourceMap = new Map();
		mockLoadOldSource = async (hash: string) => oldSourceMap.get(hash) ?? null;
	});

	teardown(() => {
		fs.rmSync(tmpBaseDir, { recursive: true, force: true });
	});

	test("ADDEDユニットのアセットがターゲットにコピーされる", async () => {
		const srcAsset = path.join(absoluteSourceDir, "assets", "img.png");
		fs.mkdirSync(path.dirname(srcAsset), { recursive: true });
		fs.writeFileSync(srcAsset, "image-data");

		const diffs: UnitDiff[] = [makeAddedDiff("![img](./assets/img.png)")];

		await copyDiffAssets({
			diffs,
			sourceUnits: [],
			sourceFile,
			config: mockConfig,
			loadOldSource: mockLoadOldSource,
		});

		const targetAsset = path.join(absoluteTargetDir, "assets", "img.png");
		assert.ok(fs.existsSync(targetAsset), "ターゲットに img.png がコピーされるべき");
	});

	test("外部URLはコピーされない（エラーにならない）", async () => {
		const diffs: UnitDiff[] = [makeAddedDiff("![img](https://example.com/img.png)")];

		await assert.doesNotReject(() =>
			copyDiffAssets({
				diffs,
				sourceUnits: [],
				sourceFile,
				config: mockConfig,
				loadOldSource: mockLoadOldSource,
			}),
		);
	});

	test("絶対パスはコピーされない（エラーにならない）", async () => {
		const diffs: UnitDiff[] = [makeAddedDiff("![img](/absolute/path/img.png)")];

		await assert.doesNotReject(() =>
			copyDiffAssets({
				diffs,
				sourceUnits: [],
				sourceFile,
				config: mockConfig,
				loadOldSource: mockLoadOldSource,
			}),
		);
	});

	test("パストラバーサルパスはコピーされない", async () => {
		const diffs: UnitDiff[] = [makeAddedDiff("![img](../../outside/secret.png)")];

		await copyDiffAssets({
			diffs,
			sourceUnits: [],
			sourceFile,
			config: mockConfig,
			loadOldSource: mockLoadOldSource,
		});

		// ターゲットディレクトリに何もコピーされていないことを確認
		const files = fs.readdirSync(absoluteTargetDir);
		assert.strictEqual(files.length, 0, "パストラバーサルパスはターゲットにコピーされるべきでない");
	});

	test("UNCHANGED+need:revise@ で旧原文との diff の新規パスのみコピーされる", async () => {
		// 旧原文には ./old.png、新原文には ./old.png と ./new.png がある想定
		const oldAsset = path.join(absoluteSourceDir, "assets", "old.png");
		const newAsset = path.join(absoluteSourceDir, "assets", "new.png");
		fs.mkdirSync(path.dirname(oldAsset), { recursive: true });
		fs.writeFileSync(oldAsset, "old");
		fs.writeFileSync(newAsset, "new");

		oldSourceMap.set("oldhash", "![img](./assets/old.png)");

		const newSourceUnit = makeUnit("newhash", "![img](./assets/old.png)\n![img2](./assets/new.png)");

		// target 側の marker は revise@oldhash、from=newhash
		const diff: UnitDiff = {
			type: DiffType.UNCHANGED,
			source: makeUnit("tgt1", "translated content", "revise@oldhash", "newhash"),
			target: makeUnit("tgt1", "translated content"),
		};

		await copyDiffAssets({
			diffs: [diff],
			sourceUnits: [newSourceUnit],
			sourceFile,
			config: mockConfig,
			loadOldSource: mockLoadOldSource,
		});

		const tgtOld = path.join(absoluteTargetDir, "assets", "old.png");
		const tgtNew = path.join(absoluteTargetDir, "assets", "new.png");
		assert.ok(!fs.existsSync(tgtOld), "旧原文にも含まれる old.png はコピーされるべきでない");
		assert.ok(fs.existsSync(tgtNew), "新原文にだけある new.png はコピーされるべき");
	});

	test("UNCHANGED+need:revise で旧原文が取得できない場合は新原文の全パスをコピー（フォールバック）", async () => {
		const srcAsset = path.join(absoluteSourceDir, "assets", "img.png");
		fs.mkdirSync(path.dirname(srcAsset), { recursive: true });
		fs.writeFileSync(srcAsset, "image-data");

		// oldSourceMap に "missing" は設定しないので loadOldSource は null を返す
		const newSourceUnit = makeUnit("newhash", "![img](./assets/img.png)");
		const diff: UnitDiff = {
			type: DiffType.UNCHANGED,
			source: makeUnit("tgt1", "translated", "revise@missing", "newhash"),
			target: makeUnit("tgt1", "translated"),
		};

		await copyDiffAssets({
			diffs: [diff],
			sourceUnits: [newSourceUnit],
			sourceFile,
			config: mockConfig,
			loadOldSource: mockLoadOldSource,
		});

		const tgt = path.join(absoluteTargetDir, "assets", "img.png");
		assert.ok(fs.existsSync(tgt), "旧原文が取れない場合は全コピーされるべき");
	});

	test("UNCHANGED+need:translate（oldhashなし）は新原文の全パスをコピー", async () => {
		const srcAsset = path.join(absoluteSourceDir, "assets", "img.png");
		fs.mkdirSync(path.dirname(srcAsset), { recursive: true });
		fs.writeFileSync(srcAsset, "image-data");

		const newSourceUnit = makeUnit("newhash", "![img](./assets/img.png)");
		const diff: UnitDiff = {
			type: DiffType.UNCHANGED,
			source: makeUnit("tgt1", "translated", "translate", "newhash"),
			target: makeUnit("tgt1", "translated"),
		};

		await copyDiffAssets({
			diffs: [diff],
			sourceUnits: [newSourceUnit],
			sourceFile,
			config: mockConfig,
			loadOldSource: mockLoadOldSource,
		});

		const tgt = path.join(absoluteTargetDir, "assets", "img.png");
		assert.ok(fs.existsSync(tgt), "need:translate は旧原文なしとして全コピーされるべき");
	});

	test("UNCHANGED で need が無い場合はコピーされない", async () => {
		const srcAsset = path.join(absoluteSourceDir, "assets", "img.png");
		fs.mkdirSync(path.dirname(srcAsset), { recursive: true });
		fs.writeFileSync(srcAsset, "image-data");

		const newSourceUnit = makeUnit("newhash", "![img](./assets/img.png)");
		const diff: UnitDiff = {
			type: DiffType.UNCHANGED,
			source: makeUnit("tgt1", "translated", null, "newhash"),
			target: makeUnit("tgt1", "translated"),
		};

		await copyDiffAssets({
			diffs: [diff],
			sourceUnits: [newSourceUnit],
			sourceFile,
			config: mockConfig,
			loadOldSource: mockLoadOldSource,
		});

		const tgt = path.join(absoluteTargetDir, "assets", "img.png");
		assert.ok(!fs.existsSync(tgt), "need がないのでコピーされるべきでない");
	});

	test("UNCHANGED+need:verify-deletion / review はコピーされない", async () => {
		const srcAsset = path.join(absoluteSourceDir, "assets", "img.png");
		fs.mkdirSync(path.dirname(srcAsset), { recursive: true });
		fs.writeFileSync(srcAsset, "image-data");

		const newSourceUnit = makeUnit("newhash", "![img](./assets/img.png)");

		for (const need of ["verify-deletion", "review"]) {
			const diff: UnitDiff = {
				type: DiffType.UNCHANGED,
				source: makeUnit("tgt1", "translated", need, "newhash"),
				target: makeUnit("tgt1", "translated"),
			};
			await copyDiffAssets({
				diffs: [diff],
				sourceUnits: [newSourceUnit],
				sourceFile,
				config: mockConfig,
				loadOldSource: mockLoadOldSource,
			});
			const tgt = path.join(absoluteTargetDir, "assets", "img.png");
			assert.ok(!fs.existsSync(tgt), `need:${need} はコピーされるべきでない`);
		}
	});

	test("DELETED / MODIFIED はコピーされない", async () => {
		const srcAsset = path.join(absoluteSourceDir, "assets", "img.png");
		fs.mkdirSync(path.dirname(srcAsset), { recursive: true });
		fs.writeFileSync(srcAsset, "image-data");

		const diffs: UnitDiff[] = [
			{
				type: DiffType.DELETED,
				source: null,
				target: makeUnit("t1", "![img](./assets/img.png)"),
			},
			{
				type: DiffType.MODIFIED,
				source: makeUnit("s1", "![img](./assets/img.png)"),
				target: makeUnit("t1", "![img](./assets/img.png)"),
			},
		];

		await copyDiffAssets({
			diffs,
			sourceUnits: [],
			sourceFile,
			config: mockConfig,
			loadOldSource: mockLoadOldSource,
		});

		const tgt = path.join(absoluteTargetDir, "assets", "img.png");
		assert.ok(!fs.existsSync(tgt), "DELETED/MODIFIED はコピーされるべきでない");
	});

	test(".md 拡張子は ADDED でもコピーされない（翻訳対象扱い）", async () => {
		const srcMd = path.join(absoluteSourceDir, "docs", "other.md");
		const srcImg = path.join(absoluteSourceDir, "assets", "img.png");
		fs.mkdirSync(path.dirname(srcMd), { recursive: true });
		fs.mkdirSync(path.dirname(srcImg), { recursive: true });
		fs.writeFileSync(srcMd, "# original\n");
		fs.writeFileSync(srcImg, "image-data");

		// target 側に翻訳済み .md を先に置く → 上書きされてはいけない
		const tgtMd = path.join(absoluteTargetDir, "docs", "other.md");
		fs.mkdirSync(path.dirname(tgtMd), { recursive: true });
		fs.writeFileSync(tgtMd, "# translated\n");

		const diffs: UnitDiff[] = [makeAddedDiff("[関連](./docs/other.md)\n![img](./assets/img.png)")];

		await copyDiffAssets({
			diffs,
			sourceUnits: [],
			sourceFile,
			config: mockConfig,
			loadOldSource: mockLoadOldSource,
		});

		const tgtImg = path.join(absoluteTargetDir, "assets", "img.png");
		assert.ok(fs.existsSync(tgtImg), "画像はコピーされるべき");
		assert.strictEqual(fs.readFileSync(tgtMd, "utf-8"), "# translated\n", ".md は翻訳対象なので上書きされてはいけない");
	});

	test("sync.copyAssets が拡張子ホワイトリストの場合、リストにない拡張子はスキップ", async () => {
		mockConfig = {
			getTransPairForSourceFile: (_: string) => ({
				sourceDir: "src",
				targetDir: "ja",
				sourceLang: "en",
				targetLang: "ja",
			}),
			getConfigBaseDir: () => tmpBaseDir,
			sync: { copyAssets: [".png"] },
			trans: { extensions: [] },
		} as unknown as Configuration;

		const srcPng = path.join(absoluteSourceDir, "img.png");
		const srcCsv = path.join(absoluteSourceDir, "data.csv");
		fs.writeFileSync(srcPng, "image");
		fs.writeFileSync(srcCsv, "csv-data");

		const diffs: UnitDiff[] = [makeAddedDiff("![img](./img.png) [data](./data.csv)")];

		await copyDiffAssets({
			diffs,
			sourceUnits: [],
			sourceFile,
			config: mockConfig,
			loadOldSource: mockLoadOldSource,
		});

		const tgtPng = path.join(absoluteTargetDir, "img.png");
		const tgtCsv = path.join(absoluteTargetDir, "data.csv");
		assert.ok(fs.existsSync(tgtPng), "ホワイトリスト .png はコピーされる");
		assert.ok(!fs.existsSync(tgtCsv), "ホワイトリストにない .csv はコピーされない");
	});

	test("transPairs[].copyAssets=false がグローバル true を上書きしてコピーされない", async () => {
		mockConfig = {
			getTransPairForSourceFile: (_: string) => ({
				sourceDir: "src",
				targetDir: "ja",
				sourceLang: "en",
				targetLang: "ja",
				copyAssets: false,
			}),
			getConfigBaseDir: () => tmpBaseDir,
			sync: { copyAssets: true },
			trans: { extensions: [] },
		} as unknown as Configuration;

		const srcAsset = path.join(absoluteSourceDir, "img.png");
		fs.writeFileSync(srcAsset, "image");

		const diffs: UnitDiff[] = [makeAddedDiff("![img](./img.png)")];

		await copyDiffAssets({
			diffs,
			sourceUnits: [],
			sourceFile,
			config: mockConfig,
			loadOldSource: mockLoadOldSource,
		});

		const tgt = path.join(absoluteTargetDir, "img.png");
		assert.ok(!fs.existsSync(tgt), "ペア単位の copyAssets:false が優先されるべき");
	});

	test('transPairs[].copyAssets=[".png"] がグローバル true を上書き（拡張子絞り込み）', async () => {
		mockConfig = {
			getTransPairForSourceFile: (_: string) => ({
				sourceDir: "src",
				targetDir: "ja",
				sourceLang: "en",
				targetLang: "ja",
				copyAssets: [".png"],
			}),
			getConfigBaseDir: () => tmpBaseDir,
			sync: { copyAssets: true },
			trans: { extensions: [] },
		} as unknown as Configuration;

		const srcPng = path.join(absoluteSourceDir, "img.png");
		const srcSvg = path.join(absoluteSourceDir, "diagram.svg");
		fs.writeFileSync(srcPng, "image");
		fs.writeFileSync(srcSvg, "svg");

		const diffs: UnitDiff[] = [makeAddedDiff("![img](./img.png) ![dia](./diagram.svg)")];

		await copyDiffAssets({
			diffs,
			sourceUnits: [],
			sourceFile,
			config: mockConfig,
			loadOldSource: mockLoadOldSource,
		});

		assert.ok(fs.existsSync(path.join(absoluteTargetDir, "img.png")), ".png はコピー");
		assert.ok(!fs.existsSync(path.join(absoluteTargetDir, "diagram.svg")), "ホワイトリスト外の .svg はコピーされない");
	});

	test("config.trans.extensions 指定拡張子はスキップされる（大文字小文字非依存）", async () => {
		mockConfig = {
			getTransPairForSourceFile: (_: string) => ({
				sourceDir: "src",
				targetDir: "ja",
				sourceLang: "en",
				targetLang: "ja",
				copyAssets: true,
			}),
			getConfigBaseDir: () => tmpBaseDir,
			sync: { copyAssets: true },
			trans: { extensions: [".txt"] },
		} as unknown as Configuration;

		const srcTxt = path.join(absoluteSourceDir, "data.TXT");
		const srcImg = path.join(absoluteSourceDir, "img.png");
		fs.writeFileSync(srcTxt, "original");
		fs.writeFileSync(srcImg, "image");

		const diffs: UnitDiff[] = [makeAddedDiff("[data](./data.TXT) ![img](./img.png)")];

		await copyDiffAssets({
			diffs,
			sourceUnits: [],
			sourceFile,
			config: mockConfig,
			loadOldSource: mockLoadOldSource,
		});

		const tgtTxt = path.join(absoluteTargetDir, "data.TXT");
		const tgtImg = path.join(absoluteTargetDir, "img.png");
		assert.ok(!fs.existsSync(tgtTxt), ".txt は trans.extensions で指定されているのでコピーされない");
		assert.ok(fs.existsSync(tgtImg), "画像はコピーされる");
	});
});
