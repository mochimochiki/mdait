/**
 * Windows で書かれた（CRLF の）原稿を、mdait が黙って書き換えないことの回帰テスト。
 *
 * 背景: `markdownParser.stringify` はどんな原稿からでも LF 連結・末尾改行1つで書き出す。
 * そのため CRLF の訳文は sync のたびに全行 LF へ書き換えられ、**内容が1文字も変わって
 * いないのにファイル全体が差分**になっていた（実測。sync の集計は added / modified とも 0）。
 * 末尾改行の無い原稿には改行が足されていた。
 *
 * いまは書き出しの入口（`writeManagedDocument`）が元の書式へ揃え直し、出来上がりが同じなら
 * 書き込み自体を見送る。ここはその番人で、**ディスク上のバイト列**を見る。
 */

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getFileHandler } from "../../../../commands/file-handler/file-handler-factory";
import { syncNew_CoreProc, sync_CoreProc } from "../../../../commands/sync/sync-command";
import { UnitRegistryManager } from "../../../../core/unit-registry/unit-registry-manager";
import { UnitStateStore } from "../../../../core/unit-state/unit-state-store";
import { Configuration } from "../../../../infra/config/configuration";
import { FileMutex } from "../../../../infra/workspace/file-mutex";

declare let __vscodeMockWorkspaceRoot: string;

const SOURCE_LINES = ["# 製品ガイド", "", "この製品の概要を説明します。", "", "## インストール", "", "手順を説明します。"];
const TARGET_LINES = [
	"# Product Guide",
	"",
	"This section describes the product overview.",
	"",
	"## Installation",
	"",
	"This section describes the installation steps.",
];

/** 改行コードと末尾改行を指定して原稿を組み立てる */
function build(lines: string[], eol: "\n" | "\r\n", trailing: boolean): string {
	return lines.join(eol) + (trailing ? eol : "");
}

for (const mode of ["embedded", "external"] as const) {
	suite(`sync: CRLF の原稿を書き換えない（${mode}）`, () => {
		let tempDir: string;
		let sourceFile: string;
		let targetFile: string;

		setup(() => {
			Configuration.dispose();
			UnitRegistryManager.resetInstance();
			UnitStateStore.dispose();
			FileMutex.dispose();
			tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-crlf-"));
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
					sync: { level: 3 },
				}),
				"utf-8",
			);
			const config = Configuration.getInstance();
			await config.initialize(configPath);
			UnitStateStore.getInstance().load(mdaitDir);
			return config;
		}

		/** CRLF の改行がいくつあるか */
		function crlfCount(file: string): number {
			return (fs.readFileSync(file, "utf-8").match(/\r\n/g) ?? []).length;
		}

		test("取り込みで CRLF の訳文が LF に書き換わらないこと", async () => {
			const config = await bootstrap();
			fs.writeFileSync(sourceFile, build(SOURCE_LINES, "\r\n", true), "utf-8");
			fs.writeFileSync(targetFile, build(TARGET_LINES, "\r\n", true), "utf-8");
			const before = fs.readFileSync(targetFile, "utf-8");

			await sync_CoreProc(sourceFile, targetFile, config, { adopt: true });

			assert.ok(crlfCount(targetFile) > 0, "CRLF が残っていること");
			assert.ok(!/[^\r]\n/.test(fs.readFileSync(targetFile, "utf-8")), "LF だけの行が混ざっていないこと");
			if (mode === "external") {
				assert.strictEqual(fs.readFileSync(targetFile, "utf-8"), before, "external では本文が1バイトも変わらない");
			}
		});

		test("通常の sync を重ねても CRLF のままであること", async () => {
			const config = await bootstrap();
			fs.writeFileSync(sourceFile, build(SOURCE_LINES, "\r\n", true), "utf-8");
			fs.writeFileSync(targetFile, build(TARGET_LINES, "\r\n", true), "utf-8");
			await sync_CoreProc(sourceFile, targetFile, config, { adopt: true });
			const afterAdopt = crlfCount(targetFile);

			await sync_CoreProc(sourceFile, targetFile, config);
			await sync_CoreProc(sourceFile, targetFile, config);

			assert.strictEqual(crlfCount(targetFile), afterAdopt);
		});

		test("末尾改行の無い原稿に改行を足さないこと", async () => {
			const config = await bootstrap();
			fs.writeFileSync(sourceFile, build(SOURCE_LINES, "\n", true), "utf-8");
			fs.writeFileSync(targetFile, build(TARGET_LINES, "\n", false), "utf-8");

			await sync_CoreProc(sourceFile, targetFile, config, { adopt: true });

			assert.ok(!fs.readFileSync(targetFile, "utf-8").endsWith("\n"), "末尾に改行が足されていないこと");
		});

		test("原文が CRLF でも書き換わらないこと（embedded はマーカーを書き込む側）", async () => {
			const config = await bootstrap();
			fs.writeFileSync(sourceFile, build(SOURCE_LINES, "\r\n", true), "utf-8");
			fs.writeFileSync(targetFile, build(TARGET_LINES, "\r\n", true), "utf-8");

			await sync_CoreProc(sourceFile, targetFile, config, { adopt: true });

			assert.ok(crlfCount(sourceFile) > 0, "原文の CRLF が残っていること");
			assert.ok(!/[^\r]\n/.test(fs.readFileSync(sourceFile, "utf-8")), "原文に LF だけの行が混ざっていないこと");
		});

		test("マーカーだけを変える操作でも CRLF が保たれること", async () => {
			const config = await bootstrap();
			fs.writeFileSync(sourceFile, build(SOURCE_LINES, "\r\n", true), "utf-8");
			fs.writeFileSync(targetFile, build(TARGET_LINES, "\r\n", true), "utf-8");
			await sync_CoreProc(sourceFile, targetFile, config, { adopt: true });

			await getFileHandler(targetFile).resolveNeed(targetFile, { needs: ["review"] });

			assert.ok(!/[^\r]\n/.test(fs.readFileSync(targetFile, "utf-8")), "LF だけの行が混ざっていないこと");
		});

		test("出来上がりが同じなら書き込まないこと（無駄な保存イベントを起こさない）", async () => {
			const config = await bootstrap();
			fs.writeFileSync(sourceFile, build(SOURCE_LINES, "\n", true), "utf-8");
			fs.writeFileSync(targetFile, build(TARGET_LINES, "\n", true), "utf-8");
			await sync_CoreProc(sourceFile, targetFile, config, { adopt: true });
			const stamp = fs.statSync(targetFile).mtimeMs;

			// 変わりようのない sync を2回。書いていれば mtime が動く
			await new Promise((resolve) => setTimeout(resolve, 10));
			await sync_CoreProc(sourceFile, targetFile, config);
			await sync_CoreProc(sourceFile, targetFile, config);

			assert.strictEqual(fs.statSync(targetFile).mtimeMs, stamp, "内容が同じなのにファイルへ書いている");
		});

		test("新しく作る訳文は LF ＋末尾改行になること（既定の書式）", async () => {
			const config = await bootstrap();
			const newSource = path.join(tempDir, "ja", "new.md");
			const newTarget = path.join(tempDir, "en", "new.md");
			fs.writeFileSync(newSource, build(SOURCE_LINES, "\r\n", true), "utf-8");

			await syncNew_CoreProc(newSource, newTarget, config);

			const created = fs.readFileSync(newTarget, "utf-8");
			assert.strictEqual((created.match(/\r\n/g) ?? []).length, 0, "新規ファイルは LF で作る");
			assert.ok(created.endsWith("\n"));
		});
	});
}
