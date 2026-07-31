// マーカー外部化 / 埋め込み戻しコマンドの中核（per-file 変換）の roundtrip 検証。
// コマンド本体は VS Code UI（withProgress/modal）に依存するため、実際の変換ロジックである
// parse(現provider) → stringify(反対provider) の組み合わせを直接検証する。

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	embedFileMarkers,
	externalizeFileMarkers,
	reconcileMarkerModeForFile,
	setMarkerModeInConfigFile,
} from "../../../../commands/markers/markers-migration";
import { embeddedMarkerProvider, externalMarkerProvider } from "../../../../core/markdown/marker-provider";
import { MdaitMarker } from "../../../../core/markdown/mdait-marker";
import { markdownParser } from "../../../../core/markdown/parser";
import { UnitStateStore } from "../../../../core/unit-state/unit-state-store";
import type { Configuration } from "../../../../infra/config/configuration";

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
			store.removeEntry(REL_PATH, entry.order);
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
