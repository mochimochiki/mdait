/**
 * frontmatter の直後の空行を、mdait が黙って詰めないことの回帰テスト。
 *
 * 背景: `markdownParser.stringify` は「frontmatter の次の行から本文」を決め打ちで書き出して
 * いた。静的サイトの原稿は閉じの `---` のあとに空行を1つ置く書き方が多く、取り込み（adopt）
 * を通しただけで**その空行が全ファイルから消えていた**（実測。マーカーを本文に書かない
 * external でも、訳文19ファイルすべてが差分になった。sync の集計は modified 0 のまま）。
 *
 * 原稿を預ける相手にとっては、内容が同じでも「勝手に書き換わった」ことが事故である
 * （ADR-260902-01 と同じ理由。ADR-260903-02）。ここはその番人で、**ディスク上のバイト列**を見る。
 */

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { syncNew_CoreProc, sync_CoreProc } from "../../../../commands/sync/sync-command";
import { UnitRegistryManager } from "../../../../core/unit-registry/unit-registry-manager";
import { UnitStateStore } from "../../../../core/unit-state/unit-state-store";
import { Configuration } from "../../../../infra/config/configuration";
import { FileMutex } from "../../../../infra/workspace/file-mutex";

declare let __vscodeMockWorkspaceRoot: string;

const SOURCE_BODY = ["# 製品ガイド", "", "この製品の概要を説明します。", "", "## インストール", "", "手順を説明します。", ""].join("\n");
const TARGET_BODY = [
	"# Product Guide",
	"",
	"This section describes the product overview.",
	"",
	"## Installation",
	"",
	"This section describes the installation steps.",
	"",
].join("\n");

/** frontmatter と本文のあいだに空行を gap 個はさんだ原稿を組み立てる */
function build(title: string, body: string, gap: number): string {
	return `---\ntitle: "${title}"\n---\n${"\n".repeat(gap)}${body}`;
}

/** frontmatter の閉じ `---` の次から、本文が始まるまでの空行の数 */
function gapOf(file: string): number {
	const lines = fs.readFileSync(file, "utf-8").split(/\r?\n/);
	const close = lines.indexOf("---", 1);
	if (close < 0) return 0;
	let gap = 0;
	while (lines[close + 1 + gap] === "") gap += 1;
	return gap;
}

for (const mode of ["embedded", "external"] as const) {
	suite(`sync: frontmatter 直後の空行を詰めない（${mode}）`, () => {
		let tempDir: string;
		let sourceFile: string;
		let targetFile: string;

		setup(() => {
			Configuration.dispose();
			UnitRegistryManager.resetInstance();
			UnitStateStore.dispose();
			FileMutex.dispose();
			tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-fmgap-"));
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
					trans: { frontmatter: { keys: ["title"] } },
				}),
				"utf-8",
			);
			const config = Configuration.getInstance();
			await config.initialize(configPath);
			UnitStateStore.getInstance().load(mdaitDir);
			return config;
		}

		test("取り込みで訳文の空行が消えないこと", async () => {
			const config = await bootstrap();
			fs.writeFileSync(sourceFile, build("製品ガイド", SOURCE_BODY, 1), "utf-8");
			fs.writeFileSync(targetFile, build("Product Guide", TARGET_BODY, 1), "utf-8");
			const before = fs.readFileSync(targetFile, "utf-8");

			await sync_CoreProc(sourceFile, targetFile, config, { adopt: true });

			assert.strictEqual(gapOf(targetFile), 1, "frontmatter 直後の空行が消えている");
			if (mode === "external") {
				assert.strictEqual(fs.readFileSync(targetFile, "utf-8"), before, "external では本文が1バイトも変わらない");
			}
		});

		test("取り込みで原文の空行も消えないこと", async () => {
			const config = await bootstrap();
			fs.writeFileSync(sourceFile, build("製品ガイド", SOURCE_BODY, 1), "utf-8");
			fs.writeFileSync(targetFile, build("Product Guide", TARGET_BODY, 1), "utf-8");

			await sync_CoreProc(sourceFile, targetFile, config, { adopt: true });

			assert.strictEqual(gapOf(sourceFile), 1, "原文の frontmatter 直後の空行が消えている");
		});

		test("空行の無い原稿に空行を足さないこと", async () => {
			const config = await bootstrap();
			fs.writeFileSync(sourceFile, build("製品ガイド", SOURCE_BODY, 0), "utf-8");
			fs.writeFileSync(targetFile, build("Product Guide", TARGET_BODY, 0), "utf-8");

			await sync_CoreProc(sourceFile, targetFile, config, { adopt: true });

			assert.strictEqual(gapOf(targetFile), 0, "空行が足されている");
			assert.strictEqual(gapOf(sourceFile), 0, "原文に空行が足されている");
		});

		test("sync を重ねても空行が増減しないこと（冪等）", async () => {
			const config = await bootstrap();
			fs.writeFileSync(sourceFile, build("製品ガイド", SOURCE_BODY, 1), "utf-8");
			fs.writeFileSync(targetFile, build("Product Guide", TARGET_BODY, 1), "utf-8");
			await sync_CoreProc(sourceFile, targetFile, config, { adopt: true });

			await sync_CoreProc(sourceFile, targetFile, config);
			await sync_CoreProc(sourceFile, targetFile, config);

			assert.strictEqual(gapOf(targetFile), 1);
			assert.strictEqual(gapOf(sourceFile), 1);
		});

		test("新しく作る訳文は原文の書き方を引き継ぐこと", async () => {
			const config = await bootstrap();
			const newSource = path.join(tempDir, "ja", "new.md");
			const newTarget = path.join(tempDir, "en", "new.md");
			fs.writeFileSync(newSource, build("新しい原稿", SOURCE_BODY, 1), "utf-8");

			await syncNew_CoreProc(newSource, newTarget, config);

			assert.strictEqual(gapOf(newTarget), 1, "原文にある空行が新しい訳文に無い");
		});
	});
}
