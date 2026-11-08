/**
 * @file plain-rebuild-verbatim.test.ts
 * @description
 *   非Markdown の再構築（unit-state に行が無いのに訳文ファイルがある）で、訳文の中身に応じて
 *   need を決めることの検証。規則は「紐なし・本文あり・丸写しでない → review、丸写し → translate」
 *   （MD 側と同じ規則）。
 *
 *   背景: 以前は一律 need:review だったため、syncNew の複製（原文の丸写し）がそのまま残った
 *   ファイルまで「確認待ち」に並び、確認する側は原文をそのまま読まされていた。
 */

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PlainFileHandler, plainContentHash } from "../../../../commands/file-handler/plain-file-handler";
import { UnitRegistryManager } from "../../../../core/unit-registry/unit-registry-manager";
import { UnitStateStore } from "../../../../core/unit-state/unit-state-store";
import { Configuration } from "../../../../infra/config/configuration";

declare let __vscodeMockWorkspaceRoot: string;

suite("非Markdown: 再構築で丸写しは翻訳待ち、訳済みは確認待ち", () => {
	let tempDir: string;
	let handler: PlainFileHandler;
	let sourceFile: string;
	let targetFile: string;

	setup(() => {
		UnitStateStore.dispose();
		UnitRegistryManager.resetInstance();
		Configuration.dispose();

		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-pfh-rebuild-"));
		__vscodeMockWorkspaceRoot = tempDir;
		// unit-state は空（＝再構築の状態）
		UnitStateStore.getInstance().load(tempDir);
		handler = new PlainFileHandler();

		sourceFile = path.join(tempDir, "source", "notice.txt");
		targetFile = path.join(tempDir, "target", "notice.txt");
		fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
		fs.mkdirSync(path.dirname(targetFile), { recursive: true });
	});

	teardown(() => {
		UnitStateStore.dispose();
		UnitRegistryManager.resetInstance();
		Configuration.dispose();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("訳文が原文の丸写しなら need:translate（まだ訳していない）", async () => {
		const source = "一行目\r\n二行目\r\n";
		fs.writeFileSync(sourceFile, source, "utf-8");
		fs.writeFileSync(targetFile, source, "utf-8");

		const result = await handler.sync(sourceFile, targetFile);

		const entry = UnitStateStore.getInstance().getSoleEntry("target/notice.txt");
		assert.ok(entry, "行が作られること");
		assert.strictEqual(entry.need, "translate");
		assert.strictEqual(entry.from, plainContentHash(source));
		assert.strictEqual(entry.hash, plainContentHash(source));
		assert.strictEqual(result.modified, 1, "行が新しく作られたので modified に数えること");
		assert.strictEqual(result.revisionsNeeded, 0, "丸写しは改訂待ちではないので数えないこと");
		assert.strictEqual(result.unchanged, 0);
	});

	test("訳文が原文と違う（訳してある）なら need:review（確認待ち）", async () => {
		fs.writeFileSync(sourceFile, "一行目\n二行目\n", "utf-8");
		fs.writeFileSync(targetFile, "Line one\nLine two\n", "utf-8");

		const result = await handler.sync(sourceFile, targetFile);

		const entry = UnitStateStore.getInstance().getSoleEntry("target/notice.txt");
		assert.ok(entry);
		assert.strictEqual(entry.need, "review");
		assert.strictEqual(result.modified, 1);
		assert.strictEqual(result.revisionsNeeded, 0, "確認待ちは改訂待ちに数えないこと（Markdown と同じ）");
		assert.strictEqual(result.adopted, 1, "紐の無い既訳を確認待ちで受けたら adopted に数えること");
	});

	test("改行コードだけが違う訳文も丸写しとみなす（まだ訳していない）", async () => {
		// 改行コードは中身ではない（ADR-261108-02）。svn:eol-style やエディタが改行コードを
		// 書き換えただけの丸写しを確認待ちにすると、翻訳が飛ばされて原文のまま残る
		fs.writeFileSync(sourceFile, "一行目\r\n二行目\r\n", "utf-8");
		fs.writeFileSync(targetFile, "一行目\n二行目\n", "utf-8");

		await handler.sync(sourceFile, targetFile);

		assert.strictEqual(UnitStateStore.getInstance().getSoleEntry("target/notice.txt")?.need, "translate");
	});

	test("再構築のあとの2回目の sync は need を据え置く（冪等）", async () => {
		const source = "一行目\n";
		fs.writeFileSync(sourceFile, source, "utf-8");
		fs.writeFileSync(targetFile, source, "utf-8");
		await handler.sync(sourceFile, targetFile);

		const second = await handler.sync(sourceFile, targetFile);

		assert.strictEqual(UnitStateStore.getInstance().getSoleEntry("target/notice.txt")?.need, "translate");
		assert.strictEqual(second.modified, 0);
		assert.strictEqual(second.unchanged, 1);
	});
});
