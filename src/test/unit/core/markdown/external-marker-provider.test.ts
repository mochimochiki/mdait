// ExternalMarkerProvider（外部ストア ↔ ユニットの橋渡し）のテスト
// 外部ストア（UnitStateStore）からのマーカー attach、本文への非出力 detach、roundtrip を検証する

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { calculateHash } from "../../../../core/hash/hash-calculator";
import { ExternalMarkerProvider, shouldPruneTail } from "../../../../core/markdown/marker-provider";
import { markdownParser } from "../../../../core/markdown/parser";
import { HELD_ORDER_BASE, UnitStateStore, isHeldBackEntry } from "../../../../core/unit-state/unit-state-store";
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

	test("detach: ユニットが急減したときは末尾の余った行を刈らず保留席へ移すこと", () => {
		// 6行ある状態で、パースが崩れて1ユニットしか取れなかった状況を作る
		for (let i = 0; i < 6; i++) {
			store.setEntry({
				path: TARGET_PATH,
				order: i,
				level: 2,
				titleHash: `t${i}`,
				hash: `hash000${i}`,
				from: `src0000${i}`,
				need: i === 5 ? "translate" : "",
			});
		}

		const provider = new ExternalMarkerProvider(store);
		const parsed = markdownParser.parse("# 見出し1\n\n本文1。\n", makeConfig(2), provider, {
			filePath: TARGET_PATH,
		});
		assert.strictEqual(parsed.units.length, 1, "前提: ユニットは1つしか取れていない");
		markdownParser.stringify(parsed, provider, { filePath: TARGET_PATH });

		const entries = store.getEntriesByPath(TARGET_PATH);
		assert.strictEqual(entries.length, 6, "末尾の行が消えていない");
		assert.strictEqual(entries.filter(isHeldBackEntry).length, 5, "生きている1件を除いて保留席へ移る");
		assert.strictEqual(entries[5].need, "translate", "need も残っている");
	});

	test("attach: 保留席の行は、内容が一致しない新しいユニットへ順序で貼り付かないこと", () => {
		// 「章を大きく減らして sync（＝保留）→ 新しい章を足す」状況。
		// 保留席の行が順序で拾われると、新章に削除済みの章の from が付き need:revise になる。
		store.setEntry({
			path: TARGET_PATH,
			order: 0,
			level: 1,
			titleHash: calculateHash("見出し1"),
			hash: calculateHash("# 見出し1\n\n本文1。\n"),
			from: "src00001",
			need: "",
		});
		for (let i = 0; i < 3; i++) {
			store.setEntry({
				path: TARGET_PATH,
				order: HELD_ORDER_BASE + i,
				level: 2,
				titleHash: `old${i}`,
				hash: `oldhash${i}`,
				from: `oldsrc${i}`,
				need: "",
			});
		}

		const provider = new ExternalMarkerProvider(store);
		const parsed = markdownParser.parse(externalDoc, makeConfig(2), provider, { filePath: TARGET_PATH });

		assert.strictEqual(parsed.units.length, 2);
		assert.strictEqual(parsed.units[1].marker.hash, "", "新しいユニットには保留席の行が付かない");
		assert.strictEqual(parsed.units[1].marker.from, null);
	});

	test("attach: 保留席の行でも、内容（本文hash）が一致すれば拾い直されること", () => {
		// 崩れを直して章が戻ってきた状況。位置ではなく内容で復帰する。
		const bodyHash = calculateHash("## 見出し2\n\n本文2。\n");
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
			order: HELD_ORDER_BASE,
			level: 2,
			titleHash: calculateHash("見出し2"),
			hash: bodyHash,
			from: "src00002",
			need: "translate",
		});

		const provider = new ExternalMarkerProvider(store);
		const parsed = markdownParser.parse(externalDoc, makeConfig(2), provider, { filePath: TARGET_PATH });

		assert.strictEqual(parsed.units[1].marker.hash, bodyHash);
		assert.strictEqual(parsed.units[1].marker.from, "src00002", "from が復帰する");
		assert.strictEqual(parsed.units[1].marker.need, "translate", "need も復帰する");
	});

	test("detach: ユニットが少し減っただけなら末尾の余った行を刈ること", () => {
		for (let i = 0; i < 3; i++) {
			store.setEntry({
				path: TARGET_PATH,
				order: i,
				level: i === 0 ? 1 : 2,
				titleHash: `t${i}`,
				hash: `hash000${i}`,
				from: `src0000${i}`,
				need: "",
			});
		}

		const provider = new ExternalMarkerProvider(store);
		const parsed = markdownParser.parse(externalDoc, makeConfig(2), provider, {
			filePath: TARGET_PATH,
		});
		assert.strictEqual(parsed.units.length, 2);
		markdownParser.stringify(parsed, provider, { filePath: TARGET_PATH });

		assert.strictEqual(store.getEntriesByPath(TARGET_PATH).length, 2, "3行目は刈られる");
	});
});

suite("shouldPruneTail（末尾行の刈り取り判定）", () => {
	test("ユニットが0件なら刈らないこと", () => {
		assert.strictEqual(shouldPruneTail(5, 0), false);
	});

	test("ユニットが減っていなければ刈ること", () => {
		assert.strictEqual(shouldPruneTail(3, 3), true);
		assert.strictEqual(shouldPruneTail(3, 5), true);
	});

	test("減少幅が小さければ刈ること（普通の章削除）", () => {
		assert.strictEqual(shouldPruneTail(10, 8), true);
		assert.strictEqual(shouldPruneTail(2, 1), true, "2件が1件は比率では半減だが件数が小さいので刈る");
		assert.strictEqual(shouldPruneTail(4, 2), true, "減少2件は疑わしさの下限に届かない");
	});

	test("半分未満へ3件以上減ったときは刈らないこと（一時的な崩れを疑う）", () => {
		assert.strictEqual(shouldPruneTail(6, 1), false);
		assert.strictEqual(shouldPruneTail(20, 1), false);
		assert.strictEqual(shouldPruneTail(7, 3), false);
	});

	test("半分以上残っていれば3件以上減っても刈ること", () => {
		assert.strictEqual(shouldPruneTail(10, 6), true);
		assert.strictEqual(shouldPruneTail(8, 4), true, "ちょうど半分は刈る");
	});
});
