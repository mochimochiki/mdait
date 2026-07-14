// マーカー外部化 / 埋め込み戻しコマンドの中核（per-file 変換）の roundtrip 検証。
// コマンド本体は VS Code UI（withProgress/modal）に依存するため、実際の変換ロジックである
// parse(現provider) → stringify(反対provider) の組み合わせを直接検証する。

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { reconcileMarkerModeForFile } from "../../../../commands/markers/markers-migration";
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
