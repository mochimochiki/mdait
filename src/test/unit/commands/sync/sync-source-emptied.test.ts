/**
 * 原文の本文が空になったときに訳文を消さないことのテスト。
 * 全選択して消した直後・差し替えの途中など、原文が一時的に空になるのは普通に起きる。
 * そのまま同期すると訳文の全ユニットが孤立扱いになり、本文ごと失われる。
 */

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	resetSourceEmptiedMemory,
	syncNew_CoreProc,
	sync_CoreProc,
	updateSourceEmptiedMemory,
} from "../../../../commands/sync/sync-command";
import { markdownParser } from "../../../../core/markdown/parser";
import { UnitRegistryManager } from "../../../../core/unit-registry/unit-registry-manager";
import { Configuration } from "../../../../infra/config/configuration";

declare let __vscodeMockWorkspaceRoot: string;

suite("sync: 原文が空になったとき訳文を守る", () => {
	let tempDir: string;
	let sourceFile: string;
	let targetFile: string;

	setup(() => {
		Configuration.dispose();
		UnitRegistryManager.resetInstance();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-empty-src-"));
		__vscodeMockWorkspaceRoot = tempDir;
		sourceFile = path.join(tempDir, "ja", "doc.md");
		targetFile = path.join(tempDir, "en", "doc.md");
		fs.mkdirSync(path.join(tempDir, "ja"), { recursive: true });
		fs.mkdirSync(path.join(tempDir, "en"), { recursive: true });
	});

	teardown(() => {
		Configuration.dispose();
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
			}),
			"utf-8",
		);
		const config = Configuration.getInstance();
		await config.initialize(configPath);
		return config;
	}

	async function bootstrap(): Promise<Configuration> {
		const config = await initConfig();
		fs.writeFileSync(
			sourceFile,
			["# 手引き", "", "導入の本文。", "", "## 第1章", "", "第1章の本文。", ""].join("\n"),
			"utf-8",
		);
		await syncNew_CoreProc(sourceFile, targetFile, config);
		return config;
	}

	test("原文の本文を空にしても訳文のファイル内容が変わらないこと", async () => {
		const config = await bootstrap();
		const before = fs.readFileSync(targetFile, "utf-8");

		fs.writeFileSync(sourceFile, "", "utf-8");
		await sync_CoreProc(sourceFile, targetFile, config);

		assert.strictEqual(fs.readFileSync(targetFile, "utf-8"), before);
	});

	test("原文の本文を空にしたことが結果に出ること（黙って見送らない）", async () => {
		const config = await bootstrap();

		fs.writeFileSync(sourceFile, "", "utf-8");
		const diff = await sync_CoreProc(sourceFile, targetFile, config);

		assert.strictEqual(diff.sourceEmptied, 1);
		assert.strictEqual(diff.deleted, 0);
	});

	test("原文を空にしたまま繰り返し同期しても同じ結果になること（冪等）", async () => {
		const config = await bootstrap();

		fs.writeFileSync(sourceFile, "", "utf-8");
		await sync_CoreProc(sourceFile, targetFile, config);
		const afterFirst = fs.readFileSync(targetFile, "utf-8");
		const second = await sync_CoreProc(sourceFile, targetFile, config);

		assert.strictEqual(fs.readFileSync(targetFile, "utf-8"), afterFirst);
		assert.strictEqual(second.sourceEmptied, 1);
	});

	test("原文を元に戻せば通常どおり同期されること（中止は一時的な足止めにすぎない）", async () => {
		const config = await bootstrap();
		fs.writeFileSync(sourceFile, "", "utf-8");
		await sync_CoreProc(sourceFile, targetFile, config);

		fs.writeFileSync(
			sourceFile,
			["# 手引き", "", "導入の本文。", "", "## 第1章", "", "第1章の本文（改訂）。", ""].join("\n"),
			"utf-8",
		);
		const diff = await sync_CoreProc(sourceFile, targetFile, config);

		assert.strictEqual(diff.sourceEmptied ?? 0, 0);
		const units = markdownParser.parse(fs.readFileSync(targetFile, "utf-8"), config).units;
		assert.strictEqual(units.length, 2);
	});

	test("原文が frontmatter だけになっても訳文は守られること", async () => {
		const config = await bootstrap();
		const before = fs.readFileSync(targetFile, "utf-8");

		fs.writeFileSync(sourceFile, ["---", "title: 手引き", "---", ""].join("\n"), "utf-8");
		const diff = await sync_CoreProc(sourceFile, targetFile, config);

		assert.strictEqual(diff.sourceEmptied, 1);
		assert.strictEqual(fs.readFileSync(targetFile, "utf-8"), before);
	});

	test("中止したときは frontmatter も書き換えないこと（状態を変えない）", async () => {
		const config = await initConfig();
		fs.writeFileSync(
			sourceFile,
			["---", "title: 手引き", "---", "", "# 手引き", "", "導入の本文。", ""].join("\n"),
			"utf-8",
		);
		await syncNew_CoreProc(sourceFile, targetFile, config);
		const before = fs.readFileSync(targetFile, "utf-8");

		fs.writeFileSync(sourceFile, ["---", "title: 手引き", "---", ""].join("\n"), "utf-8");
		await sync_CoreProc(sourceFile, targetFile, config);

		assert.strictEqual(fs.readFileSync(targetFile, "utf-8"), before);
	});

	test("明示 sync で通常どおり同期できたら「通知済み」の記憶を忘れること", async () => {
		// 保存イベント無しで原文が戻る（SCM の変更を破棄・git checkout）ことがあるため、
		// 記憶を消す機会が自動同期だけだと2度目の事故で黙る。
		const config = await bootstrap();
		resetSourceEmptiedMemory();

		fs.writeFileSync(sourceFile, "", "utf-8");
		const first = await sync_CoreProc(sourceFile, targetFile, config);
		assert.strictEqual(first.sourceEmptied, 1);
		assert.strictEqual(updateSourceEmptiedMemory(targetFile, first.sourceEmptied ?? 0), true, "1回目は通知する");
		assert.strictEqual(updateSourceEmptiedMemory(targetFile, 1), false, "続けて同じ状態なら黙る");

		// 原文が戻り、通常どおり同期できた
		fs.writeFileSync(
			sourceFile,
			["# 手引き", "", "導入の本文。", "", "## 第1章", "", "第1章の本文。", ""].join("\n"),
			"utf-8",
		);
		const restored = await sync_CoreProc(sourceFile, targetFile, config);
		assert.strictEqual(updateSourceEmptiedMemory(targetFile, restored.sourceEmptied ?? 0), false);

		// もう一度空にしたら、また通知する
		fs.writeFileSync(sourceFile, "", "utf-8");
		const again = await sync_CoreProc(sourceFile, targetFile, config);
		assert.strictEqual(updateSourceEmptiedMemory(targetFile, again.sourceEmptied ?? 0), true, "2度目の事故でも黙らない");
	});

	test("原文も訳文も空のままなら中止扱いにしないこと", async () => {
		const config = await initConfig();
		fs.writeFileSync(sourceFile, "", "utf-8");
		fs.writeFileSync(targetFile, "", "utf-8");

		const diff = await sync_CoreProc(sourceFile, targetFile, config);

		assert.strictEqual(diff.sourceEmptied ?? 0, 0);
	});
});
