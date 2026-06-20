// ExternalMarkerProvider（外部ストア ↔ ユニットの橋渡し）のテスト
// 外部ストア（UnitStateStore）からのマーカー attach、本文への非出力 detach、roundtrip を検証する

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { calculateHash } from "../../../../core/hash/hash-calculator";
import { ExternalMarkerProvider } from "../../../../core/markdown/marker-provider";
import { markdownParser } from "../../../../core/markdown/parser";
import { UnitStateStore } from "../../../../core/unit-state/unit-state-store";
import type { Configuration } from "../../../../infra/config/configuration";

function makeConfig(level: number): Configuration {
	return { sync: { level } } as unknown as Configuration;
}

function createTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "mdait-emp-"));
}

function cleanupTempDir(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

/** マーカーを含まない external ドキュメント（見出し＋本文のみ） */
const externalDoc = ["# 見出し1", "", "本文1。", "", "## 見出し2", "", "本文2。", ""].join("\n");

const TARGET_PATH = "docs/en/guide.md";

suite("ExternalMarkerProvider", () => {
	let tempDir: string;
	let store: UnitStateStore;

	setup(() => {
		UnitStateStore.dispose();
		tempDir = createTempDir();
		store = UnitStateStore.getInstance();
		store.load(tempDir);
	});

	teardown(() => {
		UnitStateStore.dispose();
		cleanupTempDir(tempDir);
	});

	test("mode は external で、markersFormBoundaries は false である", () => {
		const provider = new ExternalMarkerProvider(store);
		assert.strictEqual(provider.mode, "external");
		assert.strictEqual(provider.markersFormBoundaries, false);
	});

	test("attach: store のエントリが order 順でユニットにマーカー付与されること", () => {
		// 見出しユニットの title に合わせた titleHash を登録
		store.setEntry({
			path: TARGET_PATH,
			order: 0,
			level: 1,
			titleHash: calculateHash("見出し1"),
			hash: "aaaa1111",
			from: "src00001",
			need: "",
		});
		store.setEntry({
			path: TARGET_PATH,
			order: 1,
			level: 2,
			titleHash: calculateHash("見出し2"),
			hash: "bbbb2222",
			from: "src00002",
			need: "translate",
		});

		const provider = new ExternalMarkerProvider(store);
		const parsed = markdownParser.parse(externalDoc, makeConfig(2), provider, {
			filePath: TARGET_PATH,
			role: "target",
		});

		assert.strictEqual(parsed.units.length, 2);
		assert.strictEqual(parsed.units[0].marker.hash, "aaaa1111");
		assert.strictEqual(parsed.units[0].marker.from, "src00001");
		assert.strictEqual(parsed.units[0].marker.need, null);
		assert.strictEqual(parsed.units[1].marker.hash, "bbbb2222");
		assert.strictEqual(parsed.units[1].marker.from, "src00002");
		assert.strictEqual(parsed.units[1].marker.need, "translate");
	});

	test("attach: エントリ不足時に余ユニットが空マーカーのままになること", () => {
		store.setEntry({
			path: TARGET_PATH,
			order: 0,
			level: 1,
			titleHash: calculateHash("見出し1"),
			hash: "aaaa1111",
			from: "src00001",
			need: "",
		});

		const provider = new ExternalMarkerProvider(store);
		const parsed = markdownParser.parse(externalDoc, makeConfig(2), provider, {
			filePath: TARGET_PATH,
		});

		assert.strictEqual(parsed.units.length, 2);
		assert.strictEqual(parsed.units[0].marker.hash, "aaaa1111");
		// 2番目はエントリ不足 → 空ハッシュのまま（buildUnitsFromBoundaries 付与の空マーカー）
		assert.strictEqual(parsed.units[1].marker.hash, "");
	});

	test("attach: titleHash 不一致でも index マッチでマーカー適用されること", () => {
		store.setEntry({
			path: TARGET_PATH,
			order: 0,
			level: 1,
			titleHash: "deadbeef", // 意図的に不一致
			hash: "aaaa1111",
			from: "src00001",
			need: "",
		});

		const provider = new ExternalMarkerProvider(store);
		const parsed = markdownParser.parse(externalDoc, makeConfig(2), provider, {
			filePath: TARGET_PATH,
		});

		// 不一致でも index マッチを採用する
		assert.strictEqual(parsed.units[0].marker.hash, "aaaa1111");
	});

	test("detach → stringify で本文にマーカーが出力されないこと", () => {
		const provider = new ExternalMarkerProvider(store);
		const parsed = markdownParser.parse(externalDoc, makeConfig(2), provider, {
			filePath: TARGET_PATH,
		});
		const out = markdownParser.stringify(parsed, provider, { filePath: TARGET_PATH });

		assert.ok(!out.includes("<!-- mdait"), "本文に mdait マーカーを含まないこと");
		assert.ok(out.includes("# 見出し1"));
		assert.ok(out.includes("## 見出し2"));
	});

	test("detach で store に7カラムエントリが蓄積されること（save 未呼び出し）", () => {
		// マーカー付きで parse → detach がそのマーカーを store に書き込む
		store.setEntry({
			path: TARGET_PATH,
			order: 0,
			level: 1,
			titleHash: calculateHash("見出し1"),
			hash: "aaaa1111",
			from: "src00001",
			need: "",
		});
		store.setEntry({
			path: TARGET_PATH,
			order: 1,
			level: 2,
			titleHash: calculateHash("見出し2"),
			hash: "bbbb2222",
			from: "src00002",
			need: "translate",
		});

		const provider = new ExternalMarkerProvider(store);
		const parsed = markdownParser.parse(externalDoc, makeConfig(2), provider, {
			filePath: TARGET_PATH,
		});
		markdownParser.stringify(parsed, provider, { filePath: TARGET_PATH });

		const entries = store.getEntriesByPath(TARGET_PATH);
		assert.strictEqual(entries.length, 2);
		assert.strictEqual(entries[0].level, 1);
		assert.strictEqual(entries[0].titleHash, calculateHash("見出し1"));
		assert.strictEqual(entries[0].hash, "aaaa1111");
		assert.strictEqual(entries[1].level, 2);
		assert.strictEqual(entries[1].need, "translate");

		// save は呼ばれていない → ファイル未生成
		assert.strictEqual(fs.existsSync(path.join(tempDir, "unit-state")), false);
	});

	test("roundtrip: parse(external) → stringify で本文マーカー無し・store save で7カラム行が書かれること", () => {
		store.setEntry({
			path: TARGET_PATH,
			order: 0,
			level: 1,
			titleHash: calculateHash("見出し1"),
			hash: "aaaa1111",
			from: "src00001",
			need: "",
		});

		const provider = new ExternalMarkerProvider(store);
		const parsed = markdownParser.parse(externalDoc, makeConfig(2), provider, {
			filePath: TARGET_PATH,
		});
		const out = markdownParser.stringify(parsed, provider, { filePath: TARGET_PATH });
		assert.ok(!out.includes("<!-- mdait"));

		store.save(tempDir);
		const content = fs.readFileSync(path.join(tempDir, "unit-state"), "utf-8");
		const dataLines = content.split("\n").filter((l) => l.trim() !== "" && !l.startsWith("#"));
		assert.strictEqual(dataLines.length, 2);
		assert.ok(dataLines[0].startsWith(`${TARGET_PATH}\t0\t`));
		assert.ok(dataLines[1].startsWith(`${TARGET_PATH}\t1\t`));
	});
});
