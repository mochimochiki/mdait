/**
 * 訳文の本文が空になったときに翻訳の状態を守ることのテスト（probe S68 / ADR-260806-02）。
 *
 * 全選択して消す・翻訳会社から戻った訳文で丸ごと差し替える途中など、訳文が一時的に空になるのは
 * 普通に起きる。autoSyncOnSave があるのでその瞬間に sync が走り、以前はそこで unit-state の行が
 * `need:translate` に上書きされていた。本文を貼り戻しても行は戻らず、次の翻訳が人の訳を上書きする。
 */

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	resetTargetEmptiedMemory,
	syncNew_CoreProc,
	sync_CoreProc,
	updateTargetEmptiedMemory,
} from "../../../../commands/sync/sync-command";
import { UnitRegistryManager } from "../../../../core/unit-registry/unit-registry-manager";
import { UnitStateStore } from "../../../../core/unit-state/unit-state-store";
import { Configuration } from "../../../../infra/config/configuration";

declare let __vscodeMockWorkspaceRoot: string;

suite("sync: 訳文が空になったとき翻訳の状態を守る", () => {
	let tempDir: string;
	let sourceFile: string;
	let targetFile: string;

	setup(() => {
		Configuration.dispose();
		UnitRegistryManager.resetInstance();
		UnitStateStore.dispose();
		resetTargetEmptiedMemory();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-empty-tgt-"));
		__vscodeMockWorkspaceRoot = tempDir;
		sourceFile = path.join(tempDir, "ja", "doc.md");
		targetFile = path.join(tempDir, "en", "doc.md");
		fs.mkdirSync(path.join(tempDir, "ja"), { recursive: true });
		fs.mkdirSync(path.join(tempDir, "en"), { recursive: true });
	});

	teardown(() => {
		Configuration.dispose();
		UnitRegistryManager.resetInstance();
		UnitStateStore.dispose();
		resetTargetEmptiedMemory();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	/** external マーカーで初期同期まで済ませる */
	async function bootstrap(): Promise<Configuration> {
		const mdaitDir = path.join(tempDir, ".mdait");
		fs.mkdirSync(mdaitDir, { recursive: true });
		const configPath = path.join(mdaitDir, "mdait.json");
		fs.writeFileSync(
			configPath,
			JSON.stringify({
				transPairs: [{ sourceDir: "ja", targetDir: "en", sourceLang: "ja", targetLang: "en" }],
				primaryLang: "ja",
				markers: { mode: "external" },
			}),
			"utf-8",
		);
		const config = Configuration.getInstance();
		await config.initialize(configPath);
		UnitStateStore.getInstance().load(mdaitDir);

		fs.writeFileSync(
			sourceFile,
			["# 手引き", "", "導入の本文。", "", "## 第1章", "", "第1章の本文。", ""].join("\n"),
			"utf-8",
		);
		await syncNew_CoreProc(sourceFile, targetFile, config);
		return config;
	}

	/** 訳し終えた状態を作る（need を外し、本文を訳文らしく書き換える） */
	function markTranslated(): void {
		const store = UnitStateStore.getInstance();
		for (const entry of store.getEntriesByPath("en/doc.md")) {
			store.setEntry({ ...entry, need: "" });
		}
		fs.writeFileSync(
			targetFile,
			["# Guide", "", "Intro body.", "", "## Chapter 1", "", "Body of chapter 1.", ""].join("\n"),
			"utf-8",
		);
	}

	test("訳文を空にして同期しても unit-state の行が書き換わらないこと", async () => {
		const config = await bootstrap();
		markTranslated();
		await sync_CoreProc(sourceFile, targetFile, config);
		const before = UnitStateStore.getInstance()
			.getEntriesByPath("en/doc.md")
			.map((entry) => `${entry.seat}:${entry.hash}:${entry.from}:${entry.need}`);

		fs.writeFileSync(targetFile, "", "utf-8");
		await sync_CoreProc(sourceFile, targetFile, config);

		const after = UnitStateStore.getInstance()
			.getEntriesByPath("en/doc.md")
			.map((entry) => `${entry.seat}:${entry.hash}:${entry.from}:${entry.need}`);
		assert.deepStrictEqual(after, before);
	});

	test("訳文を空にしたことが結果に出ること（黙って見送らない）", async () => {
		const config = await bootstrap();
		markTranslated();
		await sync_CoreProc(sourceFile, targetFile, config);

		fs.writeFileSync(targetFile, "", "utf-8");
		const diff = await sync_CoreProc(sourceFile, targetFile, config);

		assert.strictEqual(diff.targetEmptied, 1);
		assert.strictEqual(diff.added, 0);
		assert.strictEqual(diff.deleted, 0);
	});

	test("訳文を空にしても本文に書き込まないこと（中止は状態を変えない）", async () => {
		const config = await bootstrap();
		markTranslated();
		await sync_CoreProc(sourceFile, targetFile, config);

		fs.writeFileSync(targetFile, "", "utf-8");
		await sync_CoreProc(sourceFile, targetFile, config);

		assert.strictEqual(fs.readFileSync(targetFile, "utf-8"), "");
	});

	test("空にして貼り戻すと need が復帰すること（S68 の本体）", async () => {
		const config = await bootstrap();
		markTranslated();
		await sync_CoreProc(sourceFile, targetFile, config);
		const translated = fs.readFileSync(targetFile, "utf-8");

		// 全選択して消す → 保存（autoSyncOnSave）
		fs.writeFileSync(targetFile, "", "utf-8");
		await sync_CoreProc(sourceFile, targetFile, config);
		// 貼り戻す → 保存
		fs.writeFileSync(targetFile, translated, "utf-8");
		await sync_CoreProc(sourceFile, targetFile, config);

		const needs = UnitStateStore.getInstance()
			.getEntriesByPath("en/doc.md")
			.map((entry) => entry.need);
		assert.deepStrictEqual(needs, ["", ""], "全ユニットが need:translate に固定されないこと");
	});

	test("空にしたまま繰り返し同期しても結果が変わらないこと（冪等）", async () => {
		const config = await bootstrap();
		markTranslated();
		await sync_CoreProc(sourceFile, targetFile, config);

		fs.writeFileSync(targetFile, "", "utf-8");
		const first = await sync_CoreProc(sourceFile, targetFile, config);
		const second = await sync_CoreProc(sourceFile, targetFile, config);

		assert.strictEqual(first.targetEmptied, 1);
		assert.strictEqual(second.targetEmptied, 1);
	});

	test("守るべき行が無ければ従来どおり訳文を作ること（空ファイルを置いて同期する使い方）", async () => {
		const config = await bootstrap();
		// 行ごと消した状態＝この訳文について mdait は何も知らない
		UnitStateStore.getInstance().removeEntriesByPath("en/doc.md");
		fs.writeFileSync(targetFile, "", "utf-8");

		const diff = await sync_CoreProc(sourceFile, targetFile, config);

		assert.strictEqual(diff.targetEmptied ?? 0, 0);
		assert.ok(fs.readFileSync(targetFile, "utf-8").length > 0, "本文が生成されること");
	});

	test("通知は同じ状態が続くあいだ1回だけで、通常同期に戻ると忘れること", () => {
		assert.strictEqual(updateTargetEmptiedMemory(targetFile, 1), true, "1回目は通知する");
		assert.strictEqual(updateTargetEmptiedMemory(targetFile, 1), false, "続くあいだは黙る");
		assert.strictEqual(updateTargetEmptiedMemory(targetFile, 0), false, "戻ったら忘れる");
		assert.strictEqual(updateTargetEmptiedMemory(targetFile, 1), true, "2度目の事故でも黙らない");
	});
});
