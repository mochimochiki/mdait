/**
 * 翻訳待ち（need:translate）の章に、印を付けたあとで人の文章が書き込まれたら確認待ち（need:review）へ
 * 切り替わることの回帰テスト（規則は `untranslated-copy.ts` の `isWrittenOverTranslateMark`）。
 *
 * 背景: `need:translate` は「次の✨翻訳が本文を上書きしてよい」の意味である。未訳の章（原文の丸写し）を
 * 人が手で訳し始めて保存しても印は translate のままで、翻訳を回すと人の文章が機械翻訳で消えた。
 * 訳し終えた章を消して保存し（sync が丸写しで作り直す）、あとで元の訳を貼り戻したときも同じ形になる。
 *
 * 一方、「この既訳は採用しない」（`requestTranslate`）は review の本文を残したまま translate に
 * 付け替える人の判断である。次の sync がそれを review に戻してはならない。決め手は
 * 「記録した本文の hash といまの本文の hash が違うか」で、印を付けた時点の本文は記録と一致する。
 */

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PlainFileHandler } from "../../../../commands/file-handler/plain-file-handler";
import { requestTranslateForFile } from "../../../../commands/markers/request-translate";
import { syncNew_CoreProc, sync_CoreProc } from "../../../../commands/sync/sync-command";
import { isWrittenOverTranslateMark } from "../../../../commands/sync/untranslated-copy";
import { UnitRegistryManager } from "../../../../core/unit-registry/unit-registry-manager";
import { UnitStateStore } from "../../../../core/unit-state/unit-state-store";
import { Configuration } from "../../../../infra/config/configuration";
import { FileMutex } from "../../../../infra/workspace/file-mutex";

declare let __vscodeMockWorkspaceRoot: string;

suite("isWrittenOverTranslateMark", () => {
	const SOURCE = "## 見出し\n\n原文。";

	test("翻訳待ちの丸写しに人の文章が書き込まれたら真", () => {
		assert.strictEqual(isWrittenOverTranslateMark("translate", "copy", "copy", "human", "## Title\n\nText.", SOURCE, false), true);
	});

	test("記録した hash といまの hash が同じなら偽（印を付けた時点の本文のまま）", () => {
		assert.strictEqual(isWrittenOverTranslateMark("translate", "human", "src", "human", "## Title\n\nText.", SOURCE, false), false);
	});

	test("translate 以外の need は対象にしない", () => {
		for (const need of ["", "review", "revise@abc", "isolate", "verify-deletion"]) {
			assert.strictEqual(isWrittenOverTranslateMark(need, "copy", "copy", "human", "## Title", SOURCE, false), false, need);
		}
	});

	test("空の本文・いまの原文の丸写し・記録した原文の丸写し・古い原文の丸写しは人の文章ではない", () => {
		assert.strictEqual(isWrittenOverTranslateMark("translate", "copy", "copy", "empty", "  \n", SOURCE, false), false);
		assert.strictEqual(isWrittenOverTranslateMark("translate", "copy", "copy", "now", SOURCE, SOURCE, false), false);
		assert.strictEqual(isWrittenOverTranslateMark("translate", "old", "from", "from", "## 旧\n\n旧。", SOURCE, false), false);
		assert.strictEqual(isWrittenOverTranslateMark("translate", "copy", "copy", "older", "## 旧旧", SOURCE, true), false);
	});
});

const SOURCE_MD = ["# 製品ガイド", "", "概要です。", "", "## インストール", "", "手順です。", ""].join("\n");

for (const mode of ["embedded", "external"] as const) {
	suite(`sync: 翻訳待ちの章に書き込まれた人の文章を守る（${mode}）`, () => {
		let tempDir: string;
		let sourceFile: string;
		let targetFile: string;

		setup(() => {
			Configuration.dispose();
			UnitRegistryManager.resetInstance();
			UnitStateStore.dispose();
			FileMutex.dispose();
			tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-written-over-"));
			__vscodeMockWorkspaceRoot = tempDir;
			fs.mkdirSync(path.join(tempDir, "ja"), { recursive: true });
			fs.mkdirSync(path.join(tempDir, "en"), { recursive: true });
			sourceFile = path.join(tempDir, "ja", "doc.md");
			targetFile = path.join(tempDir, "en", "doc.md");
		});

		teardown(() => {
			Configuration.dispose();
			UnitRegistryManager.resetInstance();
			UnitStateStore.dispose();
			FileMutex.dispose();
			fs.rmSync(tempDir, { recursive: true, force: true });
		});

		/** 設定を書いて原文を置き、訳文を作るところまで進める（訳文は全ユニット need:translate） */
		async function bootstrap(): Promise<Configuration> {
			const mdaitDir = path.join(tempDir, ".mdait");
			fs.mkdirSync(mdaitDir, { recursive: true });
			const configPath = path.join(mdaitDir, "mdait.json");
			fs.writeFileSync(
				configPath,
				JSON.stringify({
					transPairs: [{ sourceDir: "ja", targetDir: "en", sourceLang: "ja", targetLang: "en" }],
					primaryLang: "ja",
					markers: { mode },
					sync: { level: 3, autoDelete: true },
				}),
				"utf-8",
			);
			const config = Configuration.getInstance();
			await config.initialize(configPath);
			UnitStateStore.getInstance().load(mdaitDir);
			fs.writeFileSync(sourceFile, SOURCE_MD, "utf-8");
			await syncNew_CoreProc(sourceFile, targetFile, config);
			return config;
		}

		/** 訳文ユニットの (hash, need)。embedded は本文から、external は外の台帳から読む */
		function targetMarkers(): Array<{ hash: string; need: string }> {
			if (mode === "embedded") {
				const text = fs.readFileSync(targetFile, "utf-8");
				return [...text.matchAll(/<!-- mdait ([0-9a-f]+)(?: from:[0-9a-f]+)?(?: need:([\w@-]+))? -->/g)].map(
					(matched) => ({ hash: matched[1], need: matched[2] ?? "" }),
				);
			}
			return UnitStateStore.getInstance()
				.getEntriesByPath("en/doc.md")
				.filter((entry) => entry.kind === "unit")
				.map((entry) => ({ hash: entry.hash, need: entry.need }));
		}

		/** 2番目の章（インストール）を人の訳に書き換える */
		function translateSecondChapterByHand(): void {
			const text = fs.readFileSync(targetFile, "utf-8").replace("## インストール\n\n手順です。", "## Installation\n\nSteps by hand.");
			fs.writeFileSync(targetFile, text, "utf-8");
			assert.ok(fs.readFileSync(targetFile, "utf-8").includes("Steps by hand."), "人の訳を置いた（前提）");
		}

		test("未訳の章を人が手で訳して sync すると、確認待ちになり本文は残る", async () => {
			const config = await bootstrap();
			translateSecondChapterByHand();

			await sync_CoreProc(sourceFile, targetFile, config);

			assert.deepStrictEqual(
				targetMarkers().map((marker) => marker.need),
				["translate", "review"],
				"手で訳した章だけが確認待ちになる（翻訳待ちのままだと次の翻訳が上書きする）",
			);
			assert.ok(fs.readFileSync(targetFile, "utf-8").includes("Steps by hand."));
		});

		test("「採用しない」で翻訳待ちへ戻した章は、次の sync で確認待ちに戻らない", async () => {
			const config = await bootstrap();
			translateSecondChapterByHand();
			await sync_CoreProc(sourceFile, targetFile, config);
			const reviewed = targetMarkers()[1];
			assert.strictEqual(reviewed.need, "review", "確認待ちになった（前提）");

			const requested = await requestTranslateForFile(targetFile, reviewed.hash, config);
			assert.strictEqual(requested.requested, true, "翻訳待ちへ戻した（前提）");
			await sync_CoreProc(sourceFile, targetFile, config);

			assert.strictEqual(targetMarkers()[1].need, "translate", "人の判断（採用しない）を sync が覆さない");
		});

		test("丸写しのまま何度 sync しても翻訳待ちのまま", async () => {
			const config = await bootstrap();

			await sync_CoreProc(sourceFile, targetFile, config);
			await sync_CoreProc(sourceFile, targetFile, config);

			assert.deepStrictEqual(
				targetMarkers().map((marker) => marker.need),
				["translate", "translate"],
			);
		});
	});
}

suite("PlainFileHandler.sync: 翻訳待ちのファイルに書き込まれた人の文章を守る", () => {
	let tempDir: string;
	let sourceFile: string;
	let targetFile: string;

	setup(async () => {
		Configuration.dispose();
		UnitRegistryManager.resetInstance();
		UnitStateStore.dispose();
		FileMutex.dispose();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-written-over-plain-"));
		__vscodeMockWorkspaceRoot = tempDir;
		const mdaitDir = path.join(tempDir, ".mdait");
		fs.mkdirSync(mdaitDir, { recursive: true });
		fs.mkdirSync(path.join(tempDir, "ja"), { recursive: true });
		fs.mkdirSync(path.join(tempDir, "en"), { recursive: true });
		fs.writeFileSync(
			path.join(mdaitDir, "mdait.json"),
			JSON.stringify({
				transPairs: [{ sourceDir: "ja", targetDir: "en", sourceLang: "ja", targetLang: "en" }],
				primaryLang: "ja",
				trans: { extensions: [".txt"] },
			}),
			"utf-8",
		);
		await Configuration.getInstance().initialize(path.join(mdaitDir, "mdait.json"));
		UnitStateStore.getInstance().load(mdaitDir);
		sourceFile = path.join(tempDir, "ja", "doc.txt");
		targetFile = path.join(tempDir, "en", "doc.txt");
		fs.writeFileSync(sourceFile, "原文です。\n", "utf-8");
	});

	teardown(() => {
		Configuration.dispose();
		UnitRegistryManager.resetInstance();
		UnitStateStore.dispose();
		FileMutex.dispose();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("手で訳して sync すると確認待ちになり、既訳として数える", async () => {
		const handler = new PlainFileHandler();
		await handler.syncNew(sourceFile, targetFile);
		assert.strictEqual(UnitStateStore.getInstance().getSoleEntry("en/doc.txt")?.need, "translate", "前提");
		fs.writeFileSync(targetFile, "Translated by hand.\n", "utf-8");

		const result = await handler.sync(sourceFile, targetFile);

		assert.strictEqual(UnitStateStore.getInstance().getSoleEntry("en/doc.txt")?.need, "review");
		assert.strictEqual(result.adopted, 1);
		assert.strictEqual(fs.readFileSync(targetFile, "utf-8"), "Translated by hand.\n");
	});
});
