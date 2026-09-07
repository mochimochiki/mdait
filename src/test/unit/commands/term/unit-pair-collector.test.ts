/**
 * @file unit-pair-collector.test.ts
 * @description UnitPairCollector の external マーカーモード対応テスト。
 * 本文にマーカーが無い external モードでも、resolveMarkerIO 経由のパースで
 * unit-state からマーカーが attach され、ソース・ターゲットのペアが収集できることを検証する。
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { UnitPairCollector } from "../../../../commands/term/unit-pair-collector";
import { UnitPair } from "../../../../commands/term/unit-pair";
import { UnitStateStore } from "../../../../core/unit-state/unit-state-store";
import { Configuration, type TransPair } from "../../../../infra/config/configuration";
import { seat } from "../../helpers/unit-state";

declare let __vscodeMockWorkspaceRoot: string;

const transPair: TransPair = {
	sourceDir: "docs/en",
	targetDir: "docs/ja",
	sourceLang: "en",
	targetLang: "ja",
};

/** external モードの mdait.json を書いて Configuration を初期化する */
async function initExternalConfig(tempDir: string): Promise<Configuration> {
	const mdaitDir = path.join(tempDir, ".mdait");
	fs.mkdirSync(mdaitDir, { recursive: true });
	const configPath = path.join(mdaitDir, "mdait.json");
	fs.writeFileSync(
		configPath,
		JSON.stringify({
			transPairs: [transPair],
			primaryLang: "en",
			markers: { mode: "external" },
		}),
		"utf-8",
	);
	const config = Configuration.getInstance();
	await config.initialize(configPath);
	return config;
}

suite("UnitPairCollector（external マーカーモード）", () => {
	let tempDir: string;
	let store: UnitStateStore;

	setup(async () => {
		Configuration.dispose();
		UnitStateStore.dispose();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-upc-"));
		__vscodeMockWorkspaceRoot = tempDir;
		await initExternalConfig(tempDir);
		store = UnitStateStore.getInstance();
		store.load(path.join(tempDir, ".mdait"));
	});

	teardown(() => {
		Configuration.dispose();
		UnitStateStore.dispose();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("本文にマーカーが無い external ファイルでも unit-state のマーカーでソース・ターゲットのペアが収集されること", async () => {
		// 本文はマーカー無しのクリーンな Markdown（external モードの通常状態）
		const sourceRel = "docs/en/guide.md";
		const targetRel = "docs/ja/guide.md";
		const sourceAbs = path.join(tempDir, sourceRel);
		const targetAbs = path.join(tempDir, targetRel);
		fs.mkdirSync(path.dirname(sourceAbs), { recursive: true });
		fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
		fs.writeFileSync(sourceAbs, "# Title\n\nSource body.\n", "utf-8");
		fs.writeFileSync(targetAbs, "# タイトル\n\n訳文本文。\n", "utf-8");

		// マーカーは unit-state 側にのみ存在する
		store.setEntry({ path: sourceRel, kind: "unit" as const, seat: seat(0), level: 1, titleHash: "", hash: "src00001", from: "", need: "" });
		store.setEntry({
			path: targetRel,
			kind: "unit" as const, seat: seat(0),
			level: 1,
			titleHash: "",
			hash: "tgt00001",
			from: "src00001",
			need: "",
		});

		const collector = new UnitPairCollector();
		const result = await collector.collectFromFiles([sourceAbs], transPair);

		assert.strictEqual(result.pairs.length, 1, "ソースユニットのペアが1件収集される");
		assert.strictEqual(result.pairedCount, 1, "from:hash で紐づくターゲットが対訳ありと判定される");
		assert.strictEqual(result.unpairedCount, 0);
		const pair = result.pairs[0];
		assert.strictEqual(pair.source.marker?.hash, "src00001");
		assert.ok(UnitPair.hasTarget(pair), "ターゲットユニットが解決されている");
		assert.strictEqual(pair.target?.marker?.from, "src00001");
	});

	test("unit-state にエントリが無いファイルはハッシュ無しユニットとしてスキップされること", async () => {
		const sourceRel = "docs/en/lonely.md";
		const sourceAbs = path.join(tempDir, sourceRel);
		fs.mkdirSync(path.dirname(sourceAbs), { recursive: true });
		fs.writeFileSync(sourceAbs, "# Lonely\n\nNo entries.\n", "utf-8");

		const collector = new UnitPairCollector();
		const result = await collector.collectFromFiles([sourceAbs], transPair);

		assert.strictEqual(result.pairs.length, 0, "マーカー（hash）の無いユニットはペア収集対象にならない");
	});
});
