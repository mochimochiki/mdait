import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Configuration } from "../../../../infra/config/configuration";
import { UnitRegistryManager } from "../../../../core/unit-registry/unit-registry-manager";

declare let __vscodeMockWorkspaceRoot: string;

/**
 * UnitRegistryManager の note 機能テスト。
 * mock の vscode.workspace.fs は実ディスクへ読み書きするため、
 * tempDir をワークスペースルートに設定して永続化まで検証する。
 */
suite("UnitRegistryManager（note の永続化・移送）", () => {
	let tempDir: string;
	const registryPath = () => path.join(tempDir, ".mdait", "unit-registry");

	setup(() => {
		Configuration.dispose();
		UnitRegistryManager.resetInstance();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-registry-mgr-"));
		__vscodeMockWorkspaceRoot = tempDir;
	});

	teardown(() => {
		Configuration.dispose();
		UnitRegistryManager.resetInstance();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("saveNote → loadNote で note を保存・取得できる", async () => {
		const mgr = UnitRegistryManager.getInstance();
		await mgr.saveNote("aaaa1111", "intentional deviation");
		assert.equal(await mgr.loadNote("aaaa1111"), "intentional deviation");
	});

	test("保存した note がファイルへ永続化され、別インスタンスから読める", async () => {
		await UnitRegistryManager.getInstance().saveNote("aaaa1111", "persisted note");
		assert.ok(fs.existsSync(path.join(tempDir, ".mdait", "unit-registry")));

		UnitRegistryManager.resetInstance();
		assert.equal(await UnitRegistryManager.getInstance().loadNote("aaaa1111"), "persisted note");
	});

	test("空文字/null で note を削除できる", async () => {
		const mgr = UnitRegistryManager.getInstance();
		await mgr.saveNote("aaaa1111", "note");
		await mgr.saveNote("aaaa1111", "  ");
		assert.equal(await mgr.loadNote("aaaa1111"), null);
	});

	test("note と content は同一 hash で共存する", async () => {
		const mgr = UnitRegistryManager.getInstance();
		mgr.saveUnitRegistry("aaaa1111", "unit body content");
		await mgr.flushBuffer();
		await mgr.saveNote("aaaa1111", "my note");

		assert.equal(await mgr.loadNote("aaaa1111"), "my note");
		assert.equal(await mgr.loadUnitRegistry("aaaa1111"), "unit body content");
	});

	test("既にある控えは書き換えない（ファイルのバイト列が動かない）", async () => {
		// 控えは content-addressed で不変。にもかかわらず毎 sync で入れ直していたため、
		// 圧縮の出力が環境で1バイトでも違うと、中身が同じなのにファイル全体が差分になった。
		// 全行の差分は必ず合流でぶつかるので、ここは「書かない」ことが要点である
		UnitRegistryManager.getInstance().saveUnitRegistry("aaaa1111", "最初の本文");
		await UnitRegistryManager.getInstance().flushBuffer();
		const first = fs.readFileSync(registryPath(), "utf-8");

		UnitRegistryManager.resetInstance(); // キャッシュを空にして、ストア経由の判断を見る
		UnitRegistryManager.getInstance().saveUnitRegistry("aaaa1111", "あとから来た別の本文");
		await UnitRegistryManager.getInstance().flushBuffer();

		assert.equal(fs.readFileSync(registryPath(), "utf-8"), first);
	});

	test("migrateNotes で note を旧→新 hash へ移送し、旧 hash からは消える", async () => {
		const mgr = UnitRegistryManager.getInstance();
		await mgr.saveNote("a0b01111", "carry me");
		await mgr.migrateNotes([{ from: "a0b01111", to: "a0b02222" }]);

		assert.equal(await mgr.loadNote("a0b02222"), "carry me");
		assert.equal(await mgr.loadNote("a0b01111"), null);
	});

	test("migrateNotes は note の無い hash では何もしない", async () => {
		const mgr = UnitRegistryManager.getInstance();
		await mgr.migrateNotes([{ from: "a0b01111", to: "a0b02222" }]);
		assert.equal(await mgr.loadNote("a0b02222"), null);
	});

	test("migrateNotes は from===to をスキップする", async () => {
		const mgr = UnitRegistryManager.getInstance();
		await mgr.saveNote("5a3e1111", "keep");
		await mgr.migrateNotes([{ from: "5a3e1111", to: "5a3e1111" }]);
		assert.equal(await mgr.loadNote("5a3e1111"), "keep");
	});

	test("未 flush の content バッファがある状態で saveNote しても content が失われない", async () => {
		const mgr = UnitRegistryManager.getInstance();
		// saveUnitRegistry はバッファに積むだけ（flushBuffer 前）
		mgr.saveUnitRegistry("aaaa1111", "buffered content");
		// saveNote は persistStore で即時書き込み → バッファ内容も一緒に永続化されるべき
		await mgr.saveNote("bbbb2222", "a note");

		UnitRegistryManager.resetInstance();
		const reloaded = UnitRegistryManager.getInstance();
		assert.equal(await reloaded.loadUnitRegistry("aaaa1111"), "buffered content", "バッファ content が取りこぼされている");
		assert.equal(await reloaded.loadNote("bbbb2222"), "a note");
	});

	test("migrateNotes も未 flush の content バッファを取りこぼさない", async () => {
		const mgr = UnitRegistryManager.getInstance();
		await mgr.saveNote("a0b01111", "carry");
		mgr.saveUnitRegistry("cccc3333", "buffered");
		await mgr.migrateNotes([{ from: "a0b01111", to: "a0b02222" }]);

		UnitRegistryManager.resetInstance();
		const reloaded = UnitRegistryManager.getInstance();
		assert.equal(await reloaded.loadUnitRegistry("cccc3333"), "buffered");
		assert.equal(await reloaded.loadNote("a0b02222"), "carry");
	});
	test("控えの1行が壊れても、読める控えは残り、原本は unit-registry.broken へ避難する", async () => {
		const mgr = UnitRegistryManager.getInstance();
		mgr.saveUnitRegistry("aaaa1111", "old source A");
		mgr.saveUnitRegistry("bbbb2222", "old source B");
		await mgr.flushBuffer();

		// git のマージが同じ行を2度残した形（実測ではこれ1行で控えが丸ごと消えていた）
		const registryPath = path.join(tempDir, ".mdait", "unit-registry");
		const original = fs.readFileSync(registryPath, "utf-8");
		const lines = original.split("\n");
		const duplicated = lines.findIndex((line) => line.startsWith("aaaa1111 "));
		lines.splice(duplicated, 0, lines[duplicated]);
		fs.writeFileSync(registryPath, lines.join("\n"), "utf-8");

		// 読み直して、別のユニットの控えを1つ足して書き戻す（sync 1回分に相当）
		UnitRegistryManager.resetInstance();
		const reopened = UnitRegistryManager.getInstance();
		reopened.saveUnitRegistry("cccc3333", "new source C");
		await reopened.flushBuffer();

		UnitRegistryManager.resetInstance();
		const reloaded = UnitRegistryManager.getInstance();
		assert.equal(await reloaded.loadUnitRegistry("aaaa1111"), "old source A", "壊れた行のあった控えが消えている");
		assert.equal(await reloaded.loadUnitRegistry("bbbb2222"), "old source B", "無関係な控えまで消えている");
		assert.equal(await reloaded.loadUnitRegistry("cccc3333"), "new source C");
		assert.ok(
			fs.existsSync(path.join(tempDir, ".mdait", "unit-registry.broken")),
			"上書きする前に原本が避難していない",
		);
	});

	test("読めない行だけが混ざったファイルでも、読める控えは1つも失われない", async () => {
		const mgr = UnitRegistryManager.getInstance();
		mgr.saveUnitRegistry("aaaa1111", "old source A");
		await mgr.flushBuffer();

		const registryPath = path.join(tempDir, ".mdait", "unit-registry");
		fs.writeFileSync(registryPath, `${fs.readFileSync(registryPath, "utf-8")}\n<<<<<<< HEAD\n`, "utf-8");

		UnitRegistryManager.resetInstance();
		const reloaded = UnitRegistryManager.getInstance();
		assert.equal(await reloaded.loadUnitRegistry("aaaa1111"), "old source A");
	});

	test("使用中のハッシュが1つも渡されなければ GC は何もしない", async () => {
		const mgr = UnitRegistryManager.getInstance();
		mgr.saveUnitRegistry("aaaa1111", "old source A");
		await mgr.flushBuffer();

		await mgr.garbageCollect(new Set());

		UnitRegistryManager.resetInstance();
		const reloaded = UnitRegistryManager.getInstance();
		assert.equal(await reloaded.loadUnitRegistry("aaaa1111"), "old source A", "空の集合で控えが消された");
	});
});
