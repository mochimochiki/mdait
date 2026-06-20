// マーカー外部化 / 埋め込み戻しコマンドの中核（per-file 変換）の roundtrip 検証。
// コマンド本体は VS Code UI（withProgress/modal）に依存するため、実際の変換ロジックである
// parse(現provider) → stringify(反対provider) の組み合わせを直接検証する。

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { embeddedMarkerProvider, externalMarkerProvider } from "../../../../core/markdown/marker-provider";
import { MdaitMarker } from "../../../../core/markdown/mdait-marker";
import { markdownParser } from "../../../../core/markdown/parser";
import { UnitStateStore } from "../../../../core/unit-state/unit-state-store";
import type { Configuration } from "../../../../infra/config/configuration";

function makeConfig(level: number): Configuration {
	return { sync: { level } } as unknown as Configuration;
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
