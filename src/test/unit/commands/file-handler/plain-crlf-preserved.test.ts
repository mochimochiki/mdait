/**
 * @file plain-crlf-preserved.test.ts
 * @description
 *   Markdown 以外の管理下ファイル（.txt / .csv / .json）でも、mdait が原稿の改行コードを
 *   黙って書き換えないことの回帰テスト。
 *
 *   背景: AI の返す訳文は必ず LF なので、素の書き込みだと Windows で書かれた（CRLF の）
 *   訳文が翻訳のたびに全行 LF へ倒れる。内容は同じなのにファイル全体が差分になる。
 *   原稿を預ける相手にとって、拡張子は「勝手に書き換わった」かどうかと関係がない
 *   （ADR-260902-01 を非MD へも広げた）。
 *
 *   複製（syncNew）だけは唯一の入口を通してはいけない。まだ無いファイルは書式が既定（LF）と
 *   測られるため、通すと CRLF の原文がその場で倒れる。ここは両方を見張る。
 */

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type * as vscode from "vscode";
import { PlainFileHandler } from "../../../../commands/file-handler/plain-file-handler";
import type { TranslationResult, Translator } from "../../../../commands/trans/translator";
import { UnitRegistryManager } from "../../../../core/unit-registry/unit-registry-manager";
import { UnitStateStore } from "../../../../core/unit-state/unit-state-store";
import { Configuration } from "../../../../infra/config/configuration";

declare let __vscodeMockWorkspaceRoot: string;

const progress: vscode.Progress<{ message?: string; increment?: number }> = { report: () => {} };
const token: vscode.CancellationToken = {
	isCancellationRequested: false,
	onCancellationRequested: () => ({ dispose: () => {} }),
};
const pair = { sourceDir: "source", targetDir: "target", sourceLang: "ja", targetLang: "en" };

/** 指定した TranslationResult を返すだけの Translator */
function stubTranslator(result: TranslationResult): Translator {
	return {
		translate: async () => result,
		translateRevisionPatch: async () => ({ targetPatch: "" }),
	} as unknown as Translator;
}

/** LF 単独の行が1つでも残っていないか（＝すべて CRLF か） */
function hasLoneLf(text: string): boolean {
	return /(?<!\r)\n/.test(text);
}

suite("非Markdown: 原稿の改行コードを書き換えない", () => {
	let tempDir: string;
	let handler: PlainFileHandler;
	let sourceFile: string;
	let targetFile: string;

	setup(() => {
		UnitStateStore.dispose();
		UnitRegistryManager.resetInstance();
		Configuration.dispose();

		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-pfh-crlf-"));
		__vscodeMockWorkspaceRoot = tempDir;
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

	/** 翻訳待ちの行を1件用意する */
	function registerTranslateEntry(): void {
		UnitStateStore.getInstance().setEntry({
			path: "target/notice.txt",
			order: 0,
			level: 0,
			titleHash: "",
			hash: "",
			from: "",
			need: "translate",
		});
	}

	test("CRLF の訳文へ翻訳しても全行 LF に倒れないこと", async () => {
		fs.writeFileSync(sourceFile, "一行目\r\n二行目\r\n", "utf-8");
		fs.writeFileSync(targetFile, "First line\r\nSecond line\r\n", "utf-8");
		registerTranslateEntry();

		// AI の返す訳文は必ず LF
		await handler.translate(targetFile, stubTranslator({ translatedText: "Line one\nLine two\n" }), pair, progress, token);

		const written = fs.readFileSync(targetFile, "utf-8");
		assert.ok(written.includes("Line one\r\n"), "CRLF のまま書かれること");
		assert.strictEqual(hasLoneLf(written), false, "LF 単独の行が生まれていないこと");
	});

	test("末尾改行の無い訳文に改行が足されないこと", async () => {
		fs.writeFileSync(sourceFile, "一行目\n", "utf-8");
		fs.writeFileSync(targetFile, "First line", "utf-8");
		registerTranslateEntry();

		await handler.translate(targetFile, stubTranslator({ translatedText: "Line one\n" }), pair, progress, token);

		assert.strictEqual(fs.readFileSync(targetFile, "utf-8"), "Line one");
	});

	test("LF の訳文はそのまま LF で書かれること", async () => {
		fs.writeFileSync(sourceFile, "一行目\n二行目\n", "utf-8");
		fs.writeFileSync(targetFile, "First line\nSecond line\n", "utf-8");
		registerTranslateEntry();

		await handler.translate(targetFile, stubTranslator({ translatedText: "Line one\nLine two\n" }), pair, progress, token);

		assert.strictEqual(fs.readFileSync(targetFile, "utf-8"), "Line one\nLine two\n");
	});

	test("新規作成の複製は原文のバイト列をそのまま写すこと（CRLF を倒さない）", async () => {
		// ここで唯一の入口を通すと、まだ無いファイルの書式が既定（LF）と測られ、
		// 複製した時点で CRLF の原文が倒れる。複製だけは素の書き込みが正しい
		const source = "一行目\r\n二行目\r\n";
		fs.writeFileSync(sourceFile, source, "utf-8");

		await handler.syncNew(sourceFile, targetFile);

		assert.strictEqual(fs.readFileSync(targetFile, "utf-8"), source);
	});
});
