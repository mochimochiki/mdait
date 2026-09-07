// マーカー外部化 / 埋め込み戻しコマンドの中核（per-file 変換）の roundtrip 検証。
// コマンド本体は VS Code UI（withProgress/modal）に依存するため、実際の変換ロジックである
// parse(現provider) → stringify(反対provider) の組み合わせを直接検証する。

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type MigrationTarget,
	countManualSyncLevelZeroFiles,
	embedFileMarkers,
	externalizeFileMarkers,
	reconcileMarkerModeForFile,
	runMigrationLoop,
	setMarkerModeInConfigFile,
} from "../../../../commands/markers/markers-migration";
import { embeddedMarkerProvider, externalMarkerProvider } from "../../../../core/markdown/marker-provider";
import { MdaitMarker } from "../../../../core/markdown/mdait-marker";
import { markdownParser } from "../../../../core/markdown/parser";
import { UnitStateStore } from "../../../../core/unit-state/unit-state-store";
import type { Configuration } from "../../../../infra/config/configuration";
import { seat } from "../../helpers/unit-state";

declare let __vscodeMockWorkspaceRoot: string;

function makeConfig(level: number): Configuration {
	return { sync: { level } } as unknown as Configuration;
}

/** isExternalMarkers/getMarkerProvider を備えた reconcile 用の擬似 Configuration */
function makeModeConfig(level: number, mode: "embedded" | "external"): Configuration {
	return {
		sync: { level },
		isExternalMarkers: () => mode === "external",
		getMarkerProvider: () =>
			mode === "external" ? externalMarkerProvider : embeddedMarkerProvider,
	} as unknown as Configuration;
}

const REL_PATH = "docs/en/guide.md";
const headingDoc = ["# 見出し1", "", "本文1。", "", "## 見出し2", "", "本文2。", ""].join("\n");

/** マーカーを付与した embedded ドキュメントを生成する */
function buildEmbeddedDoc(): string {
	const parsed = markdownParser.parse(headingDoc, makeConfig(2), embeddedMarkerProvider);
	parsed.units[0].marker = new MdaitMarker("aaaa1111", "src00001", null);
	parsed.units[1].marker = new MdaitMarker("bbbb2222", "src00002", "translate");
	return markdownParser.stringify(parsed, embeddedMarkerProvider);
}

suite("markers-migration roundtrip", () => {
	let tempDir: string;
	let store: UnitStateStore;

	setup(() => {
		UnitStateStore.dispose();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-mig-"));
		store = UnitStateStore.getInstance();
		store.load(tempDir);
	});

	teardown(() => {
		UnitStateStore.dispose();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("externalize: 本文からマーカーが除去され store にエントリが蓄積されること", () => {
		const embeddedDoc = buildEmbeddedDoc();
		assert.ok(embeddedDoc.includes("<!-- mdait aaaa1111"), "前提: embedded 本文にマーカーがある");

		// externalize の per-file 変換: parse(embedded) → stringify(external, ctx)
		const parsed = markdownParser.parse(embeddedDoc, makeConfig(2), embeddedMarkerProvider);
		const out = markdownParser.stringify(parsed, externalMarkerProvider, { filePath: REL_PATH, role: "target" });

		assert.ok(!out.includes("<!-- mdait"), "本文からマーカーが除去される");
		const entries = store.getEntriesByPath(REL_PATH);
		assert.strictEqual(entries.length, 2);
		assert.strictEqual(entries[0].hash, "aaaa1111");
		assert.strictEqual(entries[0].from, "src00001");
		assert.strictEqual(entries[1].hash, "bbbb2222");
		assert.strictEqual(entries[1].need, "translate");
	});

	test("embed: store のマーカーが本文へ書き戻され、エントリ削除で空になること", () => {
		// 先に externalize して store を満たす
		const embeddedDoc = buildEmbeddedDoc();
		const externalized = markdownParser.stringify(
			markdownParser.parse(embeddedDoc, makeConfig(2), embeddedMarkerProvider),
			externalMarkerProvider,
			{ filePath: REL_PATH, role: "target" },
		);

		// embed の per-file 変換: parse(external, ctx) → stringify(embedded)
		const parsed = markdownParser.parse(externalized, makeConfig(2), externalMarkerProvider, {
			filePath: REL_PATH,
			role: "target",
		});
		const out = markdownParser.stringify(parsed, embeddedMarkerProvider);

		assert.ok(out.includes("<!-- mdait aaaa1111"));
		assert.ok(out.includes("bbbb2222"));
		assert.ok(out.includes("need:translate"));

		// MD ファイルの store エントリ削除
		for (const entry of store.getEntriesByPath(REL_PATH)) {
			store.removeEntry(entry);
		}
		assert.strictEqual(store.getEntriesByPath(REL_PATH).length, 0);
	});

	test("roundtrip: embedded → externalize → embed で本文が元に戻ること", () => {
		const embeddedDoc = buildEmbeddedDoc();

		const externalized = markdownParser.stringify(
			markdownParser.parse(embeddedDoc, makeConfig(2), embeddedMarkerProvider),
			externalMarkerProvider,
			{ filePath: REL_PATH, role: "target" },
		);
		const embeddedAgain = markdownParser.stringify(
			markdownParser.parse(externalized, makeConfig(2), externalMarkerProvider, {
				filePath: REL_PATH,
				role: "target",
			}),
			embeddedMarkerProvider,
		);

		assert.strictEqual(embeddedAgain, embeddedDoc);
	});
});

// コマンド本体が使う per-file 変換（externalizeFileMarkers / embedFileMarkers）を
// 実ファイル + store の永続化込みで検証する。
suite("マーカー移行コマンドの per-file 変換（外部化 / 埋め込み戻し）", () => {
	let tempDir: string;
	let prevRoot: string;
	let store: UnitStateStore;
	let absPath: string;
	const REL = "docs/en/guide.md";

	setup(() => {
		UnitStateStore.dispose();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-migrate-"));
		prevRoot = __vscodeMockWorkspaceRoot;
		__vscodeMockWorkspaceRoot = tempDir;
		store = UnitStateStore.getInstance();
		store.load(tempDir);
		absPath = path.join(tempDir, REL);
		fs.mkdirSync(path.dirname(absPath), { recursive: true });
	});

	teardown(() => {
		UnitStateStore.dispose();
		__vscodeMockWorkspaceRoot = prevRoot;
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("externalize → embed の往復（store 保存・再読込を挟む）でファイルが元に戻り、store が空になること", () => {
		const embeddedDoc = buildEmbeddedDoc();
		fs.writeFileSync(absPath, embeddedDoc, "utf-8");
		const config = makeConfig(2);

		// externalize: 本文からマーカーが消え、store に退避される
		const r1 = externalizeFileMarkers(absPath, "target", config);
		assert.strictEqual(r1.changed, true);
		assert.strictEqual(r1.unitsMigrated, 2);
		assert.strictEqual(r1.unitsDropped, 0);
		assert.ok(!fs.readFileSync(absPath, "utf-8").includes("<!-- mdait"), "本文からマーカーが除去される");
		assert.strictEqual(store.getEntriesByPath(REL).length, 2);

		// 実運用と同じく store をディスクへ保存し、別セッションを模して再読込する
		store.save(tempDir);
		UnitStateStore.dispose();
		store = UnitStateStore.getInstance();
		store.load(tempDir);
		assert.strictEqual(store.getEntriesByPath(REL).length, 2, "unit-state ファイル経由でエントリが復元される");

		// embed: 本文へマーカーが復元され、store が空になる
		const r2 = embedFileMarkers(absPath, "target", config, store);
		assert.strictEqual(r2.changed, true);
		assert.strictEqual(r2.unitsMigrated, 2);
		assert.strictEqual(fs.readFileSync(absPath, "utf-8"), embeddedDoc, "往復でファイル内容が元に戻る");
		assert.strictEqual(store.getEntriesByPath(REL).length, 0, "store のエントリが削除される");
	});

	test("見出しを伴わないサブユニット境界マーカーがあっても、後続ユニットのマーカーがずれずに退避されること", () => {
		// H1 → マーカー単独のサブ境界 → H2。external モードの境界は見出しのみなので
		// サブ境界は統合され、H2 のマーカーが order:1 に正しく入ることを検証する
		// （embedded の order をそのまま書くと H2 に サブ境界のマーカーが取り違えられる）。
		const doc = [
			"<!-- mdait aaaa1111 from:src00001 -->",
			"# 見出し1",
			"",
			"本文1。",
			"",
			"<!-- mdait cccc3333 from:sub00001 -->",
			"サブ境界の本文。",
			"",
			"<!-- mdait bbbb2222 from:src00002 need:translate -->",
			"## 見出し2",
			"",
			"本文2。",
			"",
		].join("\n");
		fs.writeFileSync(absPath, doc, "utf-8");
		const config = makeConfig(2);

		const result = externalizeFileMarkers(absPath, "target", config);

		assert.strictEqual(result.unitsMigrated, 2, "境界ユニット2件のマーカーが移送される");
		assert.strictEqual(result.unitsDropped, 1, "サブ境界マーカー1件は仕様どおり失われる");
		const entries = store.getEntriesByPath(REL);
		assert.strictEqual(entries.length, 2, "store のエントリ数は external 境界のユニット数と一致する");
		assert.strictEqual(entries[0].hash, "aaaa1111");
		assert.strictEqual(entries[0].from, "src00001");
		assert.strictEqual(entries[1].hash, "bbbb2222", "H2 には H2 自身のマーカーが入る（サブ境界のマーカーではない）");
		assert.strictEqual(entries[1].from, "src00002");
		assert.strictEqual(entries[1].need, "translate", "need 状態も正しいユニットに追従する");

		// embed で書き戻すと、H2 の直前に H2 のマーカーが復元される
		embedFileMarkers(absPath, "target", config, store);
		const body = fs.readFileSync(absPath, "utf-8");
		assert.ok(
			body.includes("<!-- mdait bbbb2222 from:src00002 need:translate -->\n## 見出し2"),
			"H2 のマーカーが正しい位置に復元される",
		);
		assert.ok(!body.includes("cccc3333"), "サブ境界マーカーは復元されない（externalize 時に失われている）");
	});

	test("embed: store エントリの無いユニットへ空スタブ <!-- mdait --> を書き込まないこと", () => {
		// external 表現のファイル（本文にマーカー無し・見出し2つ）に対し、store のエントリが
		// 先頭ユニットの1件しか無い「エントリ不足」の状態で embed する
		fs.writeFileSync(absPath, headingDoc, "utf-8");
		store.setEntry({
			path: REL,
			kind: "unit" as const, seat: seat(0),
			level: 1,
			titleHash: "",
			hash: "aaaa1111",
			from: "src00001",
			need: "",
		});
		const config = makeConfig(2);

		const result = embedFileMarkers(absPath, "target", config, store);

		const body = fs.readFileSync(absPath, "utf-8");
		assert.ok(
			body.includes("<!-- mdait aaaa1111 from:src00001 -->\n# 見出し1"),
			"エントリのあるユニットにはマーカーが復元される",
		);
		assert.ok(!/^<!--\s*mdait\s*-->\s*$/m.test(body), "エントリの無いユニットに空スタブが書き込まれない");
		assert.strictEqual(result.unitsMigrated, 1, "hash を持つマーカーだけが移送として数えられる");
		assert.strictEqual(store.getEntriesByPath(REL).length, 0, "MD ファイルの store エントリは削除される");
	});

	test("embed: 本文へ書き戻せなかったエントリは削除されずに残ること", () => {
		// 本文のユニットは1つしか無いのに、store には3行ある（本文を大きく削った途中の状態など）。
		// 対応の付かない2行の from/need を、本文にも store にも残さずに消してはならない。
		fs.writeFileSync(absPath, ["# 見出し1", "", "本文1。", ""].join("\n"), "utf-8");
		for (let i = 0; i < 3; i++) {
			store.setEntry({
				path: REL,
				kind: "unit" as const, seat: seat(i),
				level: i === 0 ? 1 : 2,
				titleHash: "",
				hash: `hash000${i}`,
				from: `src0000${i}`,
				need: i === 2 ? "translate" : "",
			});
		}

		const result = embedFileMarkers(absPath, "target", makeConfig(2), store);

		const body = fs.readFileSync(absPath, "utf-8");
		assert.ok(body.includes("<!-- mdait hash0000 from:src00000 -->"), "書き戻せた分は本文に出る");
		assert.strictEqual(result.unitsMigrated, 1);

		const remaining = store.getEntriesByPath(REL);
		assert.strictEqual(remaining.length, 2, "書き戻せなかった2行は残る");
		assert.deepStrictEqual(
			remaining.map((e) => e.hash),
			["hash0001", "hash0002"],
		);
		assert.strictEqual(remaining[1].need, "translate", "need も失われない");
	});

	test("embed: 全エントリが書き戻せた場合は行が残らないこと", () => {
		const externalized = markdownParser.stringify(
			markdownParser.parse(buildEmbeddedDoc(), makeConfig(2), embeddedMarkerProvider),
			externalMarkerProvider,
			{ filePath: REL, role: "target" },
		);
		fs.writeFileSync(absPath, externalized, "utf-8");
		assert.strictEqual(store.getEntriesByPath(REL).length, 2, "前提: store に2行ある");

		const result = embedFileMarkers(absPath, "target", makeConfig(2), store);

		assert.strictEqual(result.unitsMigrated, 2);
		assert.strictEqual(store.getEntriesByPath(REL).length, 0);
	});
});

// 一括変換ループ（runMigrationLoop）の store 保存保証を検証する。
// externalize は per-file 変換の時点で本文からマーカーを除去するため、途中で例外が起きても
// store が保存されないと、変換済みファイルのマーカーが次の sync の store.load() で永久に失われる。
suite("runMigrationLoop（一括変換ループの store 保存保証）", () => {
	let tempDir: string;
	let prevRoot: string;
	let store: UnitStateStore;

	setup(() => {
		UnitStateStore.dispose();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-miglp-"));
		prevRoot = __vscodeMockWorkspaceRoot;
		__vscodeMockWorkspaceRoot = tempDir;
		store = UnitStateStore.getInstance();
		store.load(tempDir);
	});

	teardown(() => {
		UnitStateStore.dispose();
		__vscodeMockWorkspaceRoot = prevRoot;
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	function writeEmbedded(rel: string): string {
		const abs = path.join(tempDir, rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, buildEmbeddedDoc(), "utf-8");
		return abs;
	}

	test("途中のファイルで例外が起きても、変換済みファイルのマーカーが store に保存されること", async () => {
		const okRel = "docs/en/first.md";
		const okAbs = writeEmbedded(okRel);
		// 2件目は読み込みで必ず失敗する対象（ディレクトリを指す）
		const brokenAbs = path.join(tempDir, "docs/en/broken.md");
		fs.mkdirSync(brokenAbs, { recursive: true });
		const targets: MigrationTarget[] = [
			{ absPath: okAbs, role: "target" },
			{ absPath: brokenAbs, role: "target" },
		];

		await assert.rejects(
			runMigrationLoop(targets, true, makeConfig(2), store, tempDir),
			"2件目のファイルで例外が伝播すること",
		);
		assert.ok(!fs.readFileSync(okAbs, "utf-8").includes("<!-- mdait"), "1件目は本文からマーカーが除去済み");

		// 次の sync の store.load() を模して、ディスクから読み直す
		UnitStateStore.dispose();
		store = UnitStateStore.getInstance();
		store.load(tempDir);
		const entries = store.getEntriesByPath(okRel);
		assert.strictEqual(entries.length, 2, "例外時も store が保存され、変換済みマーカーが失われないこと");
		assert.strictEqual(entries[0].hash, "aaaa1111");
		assert.strictEqual(entries[1].need, "translate");
	});

	test("移せずに落としたマーカーの数を返すこと（黙って捨てない）", async () => {
		// 落としたマーカーは from と need も一緒に失われる。以前はこの数がループで
		// 加算されず捨てられていたので、完了通知は「N 件移しました」としか言わなかった。
		// 実測では既定の見本で12件中6件が落ちていた
		const rel = "docs/en/deep.md";
		const abs = path.join(tempDir, rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(
			abs,
			[
				"<!-- mdait aaaa1111 from:src00001 -->",
				"# 見出し1",
				"",
				"本文1。",
				"",
				"<!-- mdait cccc3333 from:sub00001 need:translate -->",
				"### 深すぎる見出し",
				"",
				"落ちる本文。",
				"",
			].join("\n"),
			"utf-8",
		);
		const targets: MigrationTarget[] = [{ absPath: abs, role: "target" }];

		const result = await runMigrationLoop(targets, true, makeConfig(2), store, tempDir);

		assert.strictEqual(result.unitsDropped, 1, "落とした件数が呼び出し側へ届くこと");
	});

	test("全ファイル成功時は件数を返し、store も保存されること", async () => {
		const rel = "docs/en/guide.md";
		const abs = writeEmbedded(rel);
		const targets: MigrationTarget[] = [{ absPath: abs, role: "target" }];

		const result = await runMigrationLoop(targets, true, makeConfig(2), store, tempDir);

		assert.strictEqual(result.filesRewritten, 1);
		assert.strictEqual(result.unitsMigrated, 2);
		assert.strictEqual(result.unitsDropped, 0);
		assert.strictEqual(result.cancelled, false);

		UnitStateStore.dispose();
		store = UnitStateStore.getInstance();
		store.load(tempDir);
		assert.strictEqual(store.getEntriesByPath(rel).length, 2, "ディスクへ保存済みであること");
	});
});

// mdait.json の markers.mode 書き換えが既存の整形スタイルを壊さないことを検証する。
suite("setMarkerModeInConfigFile（mdait.json の整形保持）", () => {
	let tempDir: string;

	setup(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-cfg-"));
	});

	teardown(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	function fakeConfig(configPath: string): Configuration {
		return {
			getConfigFilePath: () => configPath,
			markers: { mode: "embedded" },
		} as unknown as Configuration;
	}

	test("2スペースインデントの mdait.json が、markers.mode 更新後もタブ化されず 2スペースのまま保たれること", async () => {
		const configPath = path.join(tempDir, "mdait.json");
		const original = ['{', '  "primaryLang": "en",', '  "sync": {', '    "level": 2', '  }', '}', ''].join("\n");
		fs.writeFileSync(configPath, original, "utf-8");
		const config = fakeConfig(configPath);

		await setMarkerModeInConfigFile(config, "external");

		const updated = fs.readFileSync(configPath, "utf-8");
		assert.ok(!updated.includes("\t"), "タブへ再整形されない");
		assert.ok(updated.includes('  "primaryLang"'), "2スペースインデントが保たれる");
		assert.ok(updated.endsWith("\n"), "末尾改行が保たれる");
		const parsed = JSON.parse(updated);
		assert.strictEqual(parsed.markers.mode, "external");
		assert.deepStrictEqual(
			Object.keys(parsed),
			["primaryLang", "sync", "markers"],
			"既存キーの順序が保たれ、markers が追加される",
		);
		assert.strictEqual(config.markers.mode, "external", "in-memory 設定も更新される");
	});

	test("タブインデントの mdait.json はタブのまま保たれること", async () => {
		const configPath = path.join(tempDir, "mdait.json");
		fs.writeFileSync(configPath, '{\n\t"sync": {\n\t\t"level": 2\n\t}\n}\n', "utf-8");
		const config = fakeConfig(configPath);

		await setMarkerModeInConfigFile(config, "external");

		const updated = fs.readFileSync(configPath, "utf-8");
		assert.ok(updated.includes('\t"sync"'), "タブインデントが保たれる");
		assert.strictEqual(JSON.parse(updated).markers.mode, "external");
	});
});

// externalize の事前スキャン: frontmatter で mdait.sync.level: 0（完全手動マーカー配置）を
// 上書きしているファイルは外部化でマーカーが失われるため、件数を確認ダイアログに含める。
suite("countManualSyncLevelZeroFiles（externalize 事前スキャン）", () => {
	let tempDir: string;

	setup(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-lvl0-"));
	});

	teardown(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	function write(rel: string, content: string): string {
		const abs = path.join(tempDir, rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, content, "utf-8");
		return abs;
	}

	test("frontmatter で mdait.sync.level: 0 を指定したファイルだけが数えられること", () => {
		const manual = write(
			"manual.md",
			["---", "mdait:", "  sync:", "    level: 0", "---", "", "# 手動運用", ""].join("\n"),
		);
		const overridden = write(
			"level3.md",
			["---", "mdait:", "  sync:", "    level: 3", "---", "", "# 上書きあり", ""].join("\n"),
		);
		const plain = write("plain.md", "# frontmatter なし\n");

		assert.strictEqual(countManualSyncLevelZeroFiles([manual, overridden, plain]), 1);
	});

	test("読めないファイルは 0 扱いで数えず、エラーにもならないこと", () => {
		const missing = path.join(tempDir, "does-not-exist.md");
		assert.strictEqual(countManualSyncLevelZeroFiles([missing]), 0);
	});
});

// 「本文マーカー運用のサイトを external に切り替える（逆も）→ markers.mode を書換えて sync」
// 動線の自己修復（reconcileMarkerModeForFile）を検証する。
suite("reconcileMarkerModeForFile (mode-switch self-heal)", () => {
	let tempDir: string;
	let prevRoot: string;
	let store: UnitStateStore;
	let absPath: string;
	const REL = "docs/en/guide.md";

	setup(() => {
		UnitStateStore.dispose();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-reconcile-"));
		prevRoot = __vscodeMockWorkspaceRoot;
		__vscodeMockWorkspaceRoot = tempDir;
		store = UnitStateStore.getInstance();
		store.load(tempDir);
		absPath = path.join(tempDir, REL);
		fs.mkdirSync(path.dirname(absPath), { recursive: true });
	});

	teardown(() => {
		UnitStateStore.dispose();
		__vscodeMockWorkspaceRoot = prevRoot;
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("external 設定で本文に埋め込みマーカーが残る場合、externalize して store へ退避すること", () => {
		fs.writeFileSync(absPath, buildEmbeddedDoc(), "utf-8");
		const config = makeModeConfig(2, "external");

		const changed = reconcileMarkerModeForFile(absPath, "target", config, store);

		assert.strictEqual(changed, true);
		const body = fs.readFileSync(absPath, "utf-8");
		assert.ok(!body.includes("<!-- mdait"), "本文からマーカーが除去される");
		const entries = store.getEntriesByPath(REL);
		assert.strictEqual(entries.length, 2);
		assert.strictEqual(entries[0].hash, "aaaa1111");
		assert.strictEqual(entries[1].need, "translate", "need 状態が保持される");

		// 冪等: 2回目は no-op（既に外部化済み）
		const again = reconcileMarkerModeForFile(absPath, "target", config, store);
		assert.strictEqual(again, false);
		assert.strictEqual(fs.readFileSync(absPath, "utf-8"), body, "2回目でファイル不変");
	});

	test("embedded 設定で store にエントリがあり本文がマーカー無しの場合、embed して store を空にすること", () => {
		// 先に externalize 済みの状態を作る
		const externalized = markdownParser.stringify(
			markdownParser.parse(buildEmbeddedDoc(), makeConfig(2), embeddedMarkerProvider),
			externalMarkerProvider,
			{ filePath: REL, role: "target" },
		);
		fs.writeFileSync(absPath, externalized, "utf-8");
		assert.strictEqual(store.getEntriesByPath(REL).length, 2, "前提: store にエントリがある");
		const config = makeModeConfig(2, "embedded");

		const changed = reconcileMarkerModeForFile(absPath, "target", config, store);

		assert.strictEqual(changed, true);
		const body = fs.readFileSync(absPath, "utf-8");
		assert.ok(body.includes("<!-- mdait aaaa1111"), "本文へマーカーが書き戻される");
		assert.ok(body.includes("need:translate"), "need 状態が本文へ復元される");
		assert.strictEqual(store.getEntriesByPath(REL).length, 0, "store のエントリが削除される");

		// 冪等: 2回目は no-op（既に埋め込み済み）
		const again = reconcileMarkerModeForFile(absPath, "target", config, store);
		assert.strictEqual(again, false);
		assert.strictEqual(fs.readFileSync(absPath, "utf-8"), body, "2回目でファイル不変");
	});

	test("sync.level 0（グローバル設定）では externalize せず、手動マーカーを破壊しないこと", () => {
		// 再現シナリオ: markers.mode を手で "external" に書き換えたサイトが sync.level: 0
		//（完全手動マーカー配置）のまま sync すると、自己修復が手動マーカー3件を
		// 見出しベース境界の store エントリ1件へ潰してしまい、need 状態ごと失われていた
		const manualDoc = [
			"<!-- mdait aaaa1111 from:src00001 -->",
			"本文1。",
			"",
			"<!-- mdait bbbb2222 from:src00002 need:translate -->",
			"本文2。",
			"",
			"<!-- mdait cccc3333 from:src00003 -->",
			"本文3。",
			"",
		].join("\n");
		fs.writeFileSync(absPath, manualDoc, "utf-8");
		const config = makeModeConfig(0, "external");

		const changed = reconcileMarkerModeForFile(absPath, "target", config, store);

		assert.strictEqual(changed, false, "externalize しない（no-op）こと");
		assert.strictEqual(fs.readFileSync(absPath, "utf-8"), manualDoc, "本文の手動マーカーが一切変わらないこと");
		assert.strictEqual(store.getEntriesByPath(REL).length, 0, "store へ退避されない（3件→1件の破壊が起きない）こと");
	});

	test("frontmatter の mdait.sync.level: 0 上書きを持つファイルも externalize されないこと", () => {
		// グローバルは level 2 でも、ファイル別上書きが 0 なら実効レベルは 0
		const doc = [
			"---",
			"mdait:",
			"  sync:",
			"    level: 0",
			"---",
			"",
			"<!-- mdait aaaa1111 from:src00001 -->",
			"# 見出し1",
			"",
			"本文1。",
			"",
			"<!-- mdait cccc3333 from:sub00001 -->",
			"手動境界の本文。",
			"",
		].join("\n");
		fs.writeFileSync(absPath, doc, "utf-8");
		const config = makeModeConfig(2, "external");

		const changed = reconcileMarkerModeForFile(absPath, "target", config, store);

		assert.strictEqual(changed, false);
		assert.strictEqual(fs.readFileSync(absPath, "utf-8"), doc, "ファイルが書き換えられないこと");
		assert.strictEqual(store.getEntriesByPath(REL).length, 0);
	});

	test("グローバル sync.level 0 でも frontmatter で 1 以上に上書きされたファイルは externalize されること", () => {
		// 実効レベルは frontmatter 優先で解決される（parser と同じ規則）
		const doc = [
			"---",
			"mdait:",
			"  sync:",
			"    level: 2",
			"---",
			"",
			"<!-- mdait aaaa1111 from:src00001 -->",
			"# 見出し1",
			"",
			"本文1。",
			"",
		].join("\n");
		fs.writeFileSync(absPath, doc, "utf-8");
		const config = makeModeConfig(0, "external");

		const changed = reconcileMarkerModeForFile(absPath, "target", config, store);

		assert.strictEqual(changed, true, "実効レベルが 1 以上なので externalize されること");
		assert.ok(!fs.readFileSync(absPath, "utf-8").includes("<!-- mdait"), "本文からマーカーが除去される");
		assert.strictEqual(store.getEntriesByPath(REL).length, 1);
		assert.strictEqual(store.getEntriesByPath(REL)[0].hash, "aaaa1111");
	});

	test("既に目標モードの表現なら no-op（書き込まない）こと", () => {
		// embedded 設定 × 本文にマーカーあり × store 空 → no-op
		fs.writeFileSync(absPath, buildEmbeddedDoc(), "utf-8");
		const before = fs.readFileSync(absPath, "utf-8");
		assert.strictEqual(
			reconcileMarkerModeForFile(absPath, "target", makeModeConfig(2, "embedded"), store),
			false,
		);
		assert.strictEqual(fs.readFileSync(absPath, "utf-8"), before);

		// external 設定 × 本文にマーカー無し → no-op
		const externalized = markdownParser.stringify(
			markdownParser.parse(buildEmbeddedDoc(), makeConfig(2), embeddedMarkerProvider),
			externalMarkerProvider,
			{ filePath: REL, role: "target" },
		);
		fs.writeFileSync(absPath, externalized, "utf-8");
		const before2 = fs.readFileSync(absPath, "utf-8");
		assert.strictEqual(
			reconcileMarkerModeForFile(absPath, "target", makeModeConfig(2, "external"), store),
			false,
		);
		assert.strictEqual(fs.readFileSync(absPath, "utf-8"), before2);
	});
});
