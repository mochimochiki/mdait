/**
 * @file md-file-handler.test.ts
 * @description MdFileHandler.isInitialized の external マーカーモード対応テスト。
 * autoSyncOnSave（extension.ts の保存フック）はこの判定に委譲しており、
 * external で本文にマーカーが無くても unit-state 登録済みなら「初期化済み」と
 * 判定されること（＝保存時 sync が沈黙しないこと）を検証する。
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MdFileHandler } from "../../../../commands/file-handler/md-file-handler";
import { UnitStateStore } from "../../../../core/unit-state/unit-state-store";
import { Configuration } from "../../../../infra/config/configuration";

declare let __vscodeMockWorkspaceRoot: string;

/** markers.mode を指定した mdait.json を書いて Configuration を初期化する */
async function initConfig(tempDir: string, mode: "embedded" | "external"): Promise<void> {
	const mdaitDir = path.join(tempDir, ".mdait");
	fs.mkdirSync(mdaitDir, { recursive: true });
	const configPath = path.join(mdaitDir, "mdait.json");
	fs.writeFileSync(
		configPath,
		JSON.stringify({
			transPairs: [{ sourceDir: "docs/en", targetDir: "docs/ja", sourceLang: "en", targetLang: "ja" }],
			primaryLang: "en",
			markers: { mode },
		}),
		"utf-8",
	);
	await Configuration.getInstance().initialize(configPath);
}

suite("MdFileHandler.isInitialized（保存時 sync の初期化判定）", () => {
	let tempDir: string;
	let handler: MdFileHandler;

	setup(() => {
		Configuration.dispose();
		UnitStateStore.dispose();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-mdfh-"));
		__vscodeMockWorkspaceRoot = tempDir;
		handler = new MdFileHandler();
	});

	teardown(() => {
		Configuration.dispose();
		UnitStateStore.dispose();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("external で本文にマーカーが無くても unit-state 登録済みなら初期化済みと判定されること", async () => {
		await initConfig(tempDir, "external");
		const rel = "docs/ja/guide.md";
		const abs = path.join(tempDir, rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, "# タイトル\n\n本文。\n", "utf-8");

		const store = UnitStateStore.getInstance();
		store.load(path.join(tempDir, ".mdait"));
		store.setEntry({ path: rel, order: 0, level: 1, titleHash: "", hash: "tgt00001", from: "src00001", need: "" });

		assert.strictEqual(await handler.isInitialized(abs), true);
	});

	test("external で unit-state 未登録かつ frontmatter マーカーも無ければ未初期化と判定されること", async () => {
		await initConfig(tempDir, "external");
		const abs = path.join(tempDir, "docs/ja/new.md");
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, "# 新規\n\nまだ sync していない。\n", "utf-8");

		UnitStateStore.getInstance().load(path.join(tempDir, ".mdait"));

		assert.strictEqual(await handler.isInitialized(abs), false);
	});

	test("embedded では本文の埋め込みマーカーで初期化済みと判定されること", async () => {
		await initConfig(tempDir, "embedded");
		const abs = path.join(tempDir, "docs/ja/guide.md");
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, "<!-- mdait tgt00001 from:src00001 -->\n# タイトル\n\n本文。\n", "utf-8");

		assert.strictEqual(await handler.isInitialized(abs), true);
	});
});
