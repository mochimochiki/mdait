// verify-deletion ユニットの Keep（恒久化＝独立ユニット化）の検証。
// need を外すだけの resolve-need.ts と異なり、need と from を同時に外す。
// 「Keep したのに次の sync で確認待ちが復活する」（unit-state.md §14(6)-(a)）が
// 起きないことを sync_CoreProc との統合で固定する。

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { keepUnitsAsIndependent } from "../../../../commands/markers/keep-unit";
import { syncNew_CoreProc, sync_CoreProc } from "../../../../commands/sync/sync-command";
import { markdownParser } from "../../../../core/markdown/parser";
import { UnitRegistryManager } from "../../../../core/unit-registry/unit-registry-manager";
import { UnitStateStore } from "../../../../core/unit-state/unit-state-store";
import { Configuration } from "../../../../infra/config/configuration";
import { FileMutex } from "../../../../infra/workspace/file-mutex";

declare let __vscodeMockWorkspaceRoot: string;

suite("keepUnitsAsIndependent（verify-deletionユニットのKeep＝独立化）", () => {
	let tempDir: string;
	let targetFile: string;

	const TARGET_CONTENT = `<!-- mdait tgtA from:srcA need:verify-deletion -->
## Section A

Content A.

<!-- mdait tgtB from:srcB -->
## Section B

Content B.

<!-- mdait tgtC from:srcC need:verify-deletion -->
## Section C

Content C.

<!-- mdait tgtD from:srcD need:review -->
## Section D

Content D.
`;

	async function initConfig(markers: Record<string, unknown> = {}): Promise<Configuration> {
		const mdaitDir = path.join(tempDir, ".mdait");
		fs.mkdirSync(mdaitDir, { recursive: true });
		fs.writeFileSync(
			path.join(mdaitDir, "mdait.json"),
			JSON.stringify({
				transPairs: [{ sourceDir: "ja", targetDir: "en", sourceLang: "ja", targetLang: "en" }],
				primaryLang: "ja",
				...(Object.keys(markers).length > 0 ? { markers } : {}),
			}),
			"utf-8",
		);
		return await Configuration.getInstance().initialize(path.join(mdaitDir, "mdait.json"));
	}

	function writeTarget(content = TARGET_CONTENT): void {
		fs.mkdirSync(path.join(tempDir, "en"), { recursive: true });
		fs.writeFileSync(targetFile, content, "utf-8");
	}

	setup(() => {
		Configuration.dispose();
		UnitStateStore.dispose();
		FileMutex.dispose();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-keep-unit-"));
		__vscodeMockWorkspaceRoot = tempDir;
		targetFile = path.join(tempDir, "en", "doc.md");
	});

	teardown(() => {
		Configuration.dispose();
		UnitStateStore.dispose();
		FileMutex.dispose();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("hash指定のKeepでneedとfromが同時に外れ、本文とhashは不変", async () => {
		const config = await initConfig();
		writeTarget();

		const result = await keepUnitsAsIndependent(targetFile, config, ["tgtA"]);

		assert.strictEqual(result.kept.length, 1);
		assert.deepStrictEqual(result.kept[0], { hash: "tgtA", title: "Section A" });
		const written = fs.readFileSync(targetFile, "utf-8");
		assert.ok(written.includes("<!-- mdait tgtA -->"), "needとfromが外れた素hashマーカーになること");
		assert.ok(!written.includes("from:srcA"), "fromが残らないこと（残ると次のsyncで確認待ちが復活する）");
		assert.ok(written.includes("Content A."), "本文は保持されること");
		assert.ok(written.includes("need:verify-deletion"), "指定外のverify-deletionは残ること");
	});

	test("hash省略でファイル内の全verify-deletionが独立化され、他のneedは触られない", async () => {
		const config = await initConfig();
		writeTarget();

		const result = await keepUnitsAsIndependent(targetFile, config);

		assert.deepStrictEqual(
			result.kept.map((k) => k.hash),
			["tgtA", "tgtC"],
		);
		const written = fs.readFileSync(targetFile, "utf-8");
		assert.ok(!written.includes("need:verify-deletion"));
		assert.ok(!written.includes("from:srcA"));
		assert.ok(!written.includes("from:srcC"));
		assert.ok(written.includes("from:srcB"), "確認待ちでないユニットのfromは保持されること");
		assert.ok(written.includes("need:review"), "reviewの判断待ちを踏み潰さないこと");
	});

	test("verify-deletion以外のユニットはKeepできない（安全弁）", async () => {
		const config = await initConfig();
		writeTarget();

		const result = await keepUnitsAsIndependent(targetFile, config, ["tgtB", "tgtD", "zzz"]);

		assert.strictEqual(result.kept.length, 0);
		assert.deepStrictEqual(result.skipped, [
			{ hash: "tgtB", reason: "not-verify-deletion" },
			{ hash: "tgtD", reason: "not-verify-deletion" },
			{ hash: "zzz", reason: "not-found" },
		]);
		assert.strictEqual(fs.readFileSync(targetFile, "utf-8"), TARGET_CONTENT, "ファイルは変更されないこと");
	});

	test("2回目のKeepは対象0件で無変更（冪等性）", async () => {
		const config = await initConfig();
		writeTarget();
		const first = await keepUnitsAsIndependent(targetFile, config);
		assert.strictEqual(first.kept.length, 2);
		const afterFirst = fs.readFileSync(targetFile, "utf-8");

		const second = await keepUnitsAsIndependent(targetFile, config);
		assert.strictEqual(second.kept.length, 0);
		assert.strictEqual(second.changed, false);
		assert.strictEqual(fs.readFileSync(targetFile, "utf-8"), afterFirst);
	});

	test("hashの無い手書きverify-deletionマーカーはKeep時にhashが合成され、独立ユニットの条件を満たす", async () => {
		// sync の独立ユニット保護は「hash あり・from なし」。hash 無しのまま need だけ外すと
		// 次の sync で need:review の列へ戻り、「以後対応付けない」という通知と矛盾する
		const config = await initConfig();
		writeTarget(`<!-- mdait need:verify-deletion -->
## Handwritten

Handwritten content.
`);

		const result = await keepUnitsAsIndependent(targetFile, config);

		assert.strictEqual(result.kept.length, 1);
		assert.ok(result.kept[0].hash, "合成されたhashが結果に載ること");
		const written = fs.readFileSync(targetFile, "utf-8");
		assert.ok(!written.includes("need:verify-deletion"));
		assert.match(written, /<!-- mdait [a-zA-Z0-9]+ -->/, "hash付きの素マーカーになること");
	});

	test("同一hashのverify-deletionが2つあっても、単体Keepを2回で両方に到達できる", async () => {
		// hash は本文CRCなので同一本文の章は同じhashになる。先頭一致だけだと
		// 1つ目のKeep後に2つ目へ永久に到達できない（正しさレビューの指摘）
		const config = await initConfig();
		writeTarget(`<!-- mdait dup1 from:srcA need:verify-deletion -->
## Same

Same content.

<!-- mdait dup1 from:srcB need:verify-deletion -->
## Same

Same content.
`);

		const first = await keepUnitsAsIndependent(targetFile, config, ["dup1"]);
		assert.strictEqual(first.kept.length, 1);

		const second = await keepUnitsAsIndependent(targetFile, config, ["dup1"]);
		assert.strictEqual(second.kept.length, 1, "2回目はまだverify-deletionの方が優先して選ばれること");

		const written = fs.readFileSync(targetFile, "utf-8");
		assert.ok(!written.includes("need:verify-deletion"), "両方とも独立化されること");
		assert.ok(!written.includes("from:"), "両方のfromが外れること");
	});

	test("externalマーカーモードではストアの行からもneedとfromが外れる", async () => {
		const config = await initConfig({ mode: "external" });
		const externalContent = "## Section A\n\nContent A.\n\n## Section B\n\nContent B.\n";
		writeTarget(externalContent);

		const store = UnitStateStore.getInstance();
		store.load(path.join(tempDir, ".mdait"));
		store.setEntry({
			path: "en/doc.md",
			order: 0,
			level: 2,
			titleHash: "",
			hash: "tgtA",
			from: "srcA",
			need: "verify-deletion",
		});
		store.setEntry({ path: "en/doc.md", order: 1, level: 2, titleHash: "", hash: "tgtB", from: "srcB", need: "" });

		const result = await keepUnitsAsIndependent(targetFile, config, ["tgtA"]);

		assert.strictEqual(result.kept.length, 1);
		const entries = UnitStateStore.getInstance().getEntriesByPath("en/doc.md");
		const keptEntry = entries.find((e) => e.hash === "tgtA");
		assert.ok(keptEntry);
		assert.strictEqual(keptEntry.need, "", "ストアの行からneedが外れること");
		assert.strictEqual(keptEntry.from, "", "ストアの行からfromが外れること");
		const other = entries.find((e) => e.hash === "tgtB");
		assert.strictEqual(other?.from, "srcB", "他ユニットの行は不変であること");
	});
});

suite("Keepの恒久性（sync統合。unit-state.md §14(6)-(a) の解消）", () => {
	let tempDir: string;
	let sourceFile: string;
	let targetFile: string;

	setup(() => {
		Configuration.dispose();
		UnitStateStore.dispose();
		FileMutex.dispose();
		UnitRegistryManager.resetInstance();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-keep-sync-"));
		__vscodeMockWorkspaceRoot = tempDir;
		sourceFile = path.join(tempDir, "ja", "doc.md");
		targetFile = path.join(tempDir, "en", "doc.md");
		fs.mkdirSync(path.join(tempDir, "ja"), { recursive: true });
		fs.mkdirSync(path.join(tempDir, "en"), { recursive: true });
	});

	teardown(() => {
		Configuration.dispose();
		UnitStateStore.dispose();
		FileMutex.dispose();
		UnitRegistryManager.resetInstance();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	async function initConfig(): Promise<Configuration> {
		const mdaitDir = path.join(tempDir, ".mdait");
		fs.mkdirSync(mdaitDir, { recursive: true });
		const configPath = path.join(mdaitDir, "mdait.json");
		fs.writeFileSync(
			configPath,
			JSON.stringify({
				transPairs: [{ sourceDir: "ja", targetDir: "en", sourceLang: "ja", targetLang: "en" }],
				primaryLang: "ja",
				sync: { orphanTargetPolicy: "verify" },
			}),
			"utf-8",
		);
		return await Configuration.getInstance().initialize(configPath);
	}

	function parseUnits(filePath: string) {
		return markdownParser.parse(fs.readFileSync(filePath, "utf-8"), Configuration.getInstance()).units;
	}

	test("Keepしたユニットは次のsyncで確認待ちが復活せず、独立ユニットとして保持される", async () => {
		const config = await initConfig();
		fs.writeFileSync(sourceFile, ["## 概要", "", "概要の本文。", "", "## 付録", "", "付録の本文。", ""].join("\n"), "utf-8");
		await syncNew_CoreProc(sourceFile, targetFile, config);

		// 原文から「付録」を削除して sync → 訳文側が確認待ちになる
		fs.writeFileSync(sourceFile, ["## 概要", "", "概要の本文。", ""].join("\n"), "utf-8");
		await sync_CoreProc(sourceFile, targetFile, config);
		const pending = parseUnits(targetFile).find((u) => u.title === "付録");
		assert.ok(pending?.marker);
		assert.strictEqual(pending.marker.need, "verify-deletion", "前提: 確認待ちになっていること");
		const pendingHash = pending.marker.hash;

		// Keep（独立化）
		const keepResult = await keepUnitsAsIndependent(targetFile, config, [pendingHash]);
		assert.strictEqual(keepResult.kept.length, 1);

		// 次の sync で確認待ちが復活しないこと（旧Keepはここで復活していた）
		const diff = await sync_CoreProc(sourceFile, targetFile, config);
		const keptUnit = parseUnits(targetFile).find((u) => u.title === "付録");
		assert.ok(keptUnit, "Keepしたユニットの本文が保持されること");
		assert.strictEqual(keptUnit.marker?.need, null, "確認待ちが復活しないこと");
		assert.strictEqual(keptUnit.marker?.from, null, "独立ユニットのままであること");
		assert.strictEqual(diff.kept, 1, "syncが独立ユニットとして数えること");

		// さらにもう1回 sync しても不変（冪等性）
		const before = fs.readFileSync(targetFile, "utf-8");
		await sync_CoreProc(sourceFile, targetFile, config);
		assert.strictEqual(fs.readFileSync(targetFile, "utf-8"), before);
	});

	test("Keepした章の原文が復活すると、独立ユニットの隣に新規translateユニットが並ぶ（ADR-260805-01の受け入れた帰結）", async () => {
		// 独立化は「機械の対応付けから外す」という人の宣言なので、原文が戻っても再連結しない。
		// 同名章が2本並ぶのは宣言どおりの挙動 — この帰結が変わったら ADR の再訪が要る
		const config = await initConfig();
		fs.writeFileSync(sourceFile, ["## 概要", "", "概要の本文。", "", "## 付録", "", "付録の本文。", ""].join("\n"), "utf-8");
		await syncNew_CoreProc(sourceFile, targetFile, config);

		// 原文から「付録」を削除 → sync → Keep（独立化）
		fs.writeFileSync(sourceFile, ["## 概要", "", "概要の本文。", ""].join("\n"), "utf-8");
		await sync_CoreProc(sourceFile, targetFile, config);
		const pending = parseUnits(targetFile).find((u) => u.title === "付録");
		assert.ok(pending?.marker);
		await keepUnitsAsIndependent(targetFile, config, [pending.marker.hash]);

		// 原文の「付録」を復活させて sync
		fs.writeFileSync(sourceFile, ["## 概要", "", "概要の本文。", "", "## 付録", "", "付録の本文。", ""].join("\n"), "utf-8");
		await sync_CoreProc(sourceFile, targetFile, config);

		const appendixUnits = parseUnits(targetFile).filter((u) => u.title === "付録");
		assert.strictEqual(appendixUnits.length, 2, "独立ユニットと新規translateの2本が並ぶこと");
		const independent = appendixUnits.find((u) => !u.marker?.from);
		const fresh = appendixUnits.find((u) => u.marker?.from);
		assert.ok(independent, "Keepした独立ユニットが保持されること");
		assert.strictEqual(independent.marker?.need, null);
		assert.ok(fresh, "復活した原文から新規ユニットが生成されること");
		assert.strictEqual(fresh.marker?.need, "translate");

		// 2回目の sync で増殖しない（冪等性）
		const before = fs.readFileSync(targetFile, "utf-8");
		await sync_CoreProc(sourceFile, targetFile, config);
		assert.strictEqual(fs.readFileSync(targetFile, "utf-8"), before);
	});
});
