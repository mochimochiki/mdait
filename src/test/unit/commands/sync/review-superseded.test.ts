/**
 * 取り込んだ既訳が、原文の改訂で消えないことの回帰テスト（ADR-260901-01）。
 *
 * 背景: `need:review` のあいだだけ訳文の `from` を据え置く凍結を入れたところ、同じ sync が
 * 原文側の `hash` は進めるため、紐（原文の hash と訳文の from の一致）がその場で切れていた。
 * 人が確認を終えて印を外した次の sync で、訳文の章は「原文が消えた孤立」に落ち、既定設定
 * （`sync.autoDelete: true`）で**英文がまるごと物理削除**された。実測では同じ位置に日本語の
 * 原文が `need:translate` で置き直された。
 *
 * **マッチャを通した実経路で確かめる。** `syncMarkerPair` を直に呼ぶ単体テストはこの事故を
 * 検出できなかった（呼び出し側でペアを手渡すため、ペアが作られないという壊れ方が現れない）。
 * ここは sync_CoreProc を通し、ディスク上の訳文の本文を見る。
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

/** 既存の日英サイトの原文。3章あり、真ん中の章だけをあとで改訂する */
const SOURCE = [
	"# 製品ガイド",
	"",
	"この製品の概要を説明します。",
	"",
	"## インストール",
	"",
	"インストール手順を説明します。",
	"",
	"## 使い方",
	"",
	"基本的な使い方を説明します。",
	"",
].join("\n");

/** 既にある訳文。マーカーは無い（人が手で書いた既訳） */
const TARGET = [
	"# Product Guide",
	"",
	"This section describes the product overview.",
	"",
	"## Installation",
	"",
	"This section describes the installation steps.",
	"",
	"## Usage",
	"",
	"This section describes basic usage.",
	"",
].join("\n");

/** 真ん中の章に1文足す（原文に書かれたマーカーは残す。消すと別物のファイルになる） */
function reviseSource(file: string): void {
	const revised = fs
		.readFileSync(file, "utf-8")
		.replace("インストール手順を説明します。", "インストール手順を説明します。前提条件も確認してください。");
	fs.writeFileSync(file, revised, "utf-8");
}

/** 改訂を元に戻す（同上） */
function undoRevision(file: string): void {
	const back = fs
		.readFileSync(file, "utf-8")
		.replace("インストール手順を説明します。前提条件も確認してください。", "インストール手順を説明します。");
	fs.writeFileSync(file, back, "utf-8");
}

for (const mode of ["embedded", "external"] as const) {
	suite(`sync: 取り込んだ既訳は原文の改訂で消えない（${mode}）`, () => {
		let tempDir: string;
		let sourceFile: string;
		let targetFile: string;

		setup(() => {
			Configuration.dispose();
			UnitRegistryManager.resetInstance();
			UnitStateStore.dispose();
			FileMutex.dispose();
			tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-review-superseded-"));
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

		/** 設定を書いて原稿を置き、取り込み（adopt）まで済ませる */
		async function adopt(): Promise<Configuration> {
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
			fs.writeFileSync(sourceFile, SOURCE, "utf-8");
			fs.writeFileSync(targetFile, TARGET, "utf-8");
			await sync_CoreProc(sourceFile, targetFile, config, { adopt: true });
			return config;
		}

		/** 訳文ユニットの need の並び（embedded は本文のマーカー、external は外の台帳から読む） */
		function targetNeeds(): string[] {
			if (mode === "embedded") {
				return [...fs.readFileSync(targetFile, "utf-8").matchAll(/<!-- mdait[^>]*need:([\w@-]+)[^>]*-->/g)].map(
					(matched) => matched[1],
				);
			}
			return UnitStateStore.getInstance()
				.getEntriesByPath("en/doc.md")
				.map((entry) => entry.need)
				.filter((need) => need !== "");
		}

		/** 訳文の本文（マーカーの行を除く） */
		function targetBody(): string {
			return fs
				.readFileSync(targetFile, "utf-8")
				.split("\n")
				.filter((line) => !line.trimStart().startsWith("<!-- mdait"))
				.join("\n");
		}

		test("取り込みで既訳の本文が変わらず、確認待ちになること（前提）", async () => {
			await adopt();
			assert.strictEqual(targetBody(), TARGET, "取り込みは既訳の本文を1文字も変えない");
			assert.deepStrictEqual(targetNeeds(), ["review", "review", "review"], "取り込んだ対応は確認待ちになる");
		});

		test("確認待ちのまま原文を改訂しても、英文が残り改訂待ちへ移ること", async () => {
			const config = await adopt();
			reviseSource(sourceFile);

			const result = await sync_CoreProc(sourceFile, targetFile, config);

			assert.strictEqual(targetBody(), TARGET, "改訂は訳文の本文に触れない（訳し直すのは trans）");
			assert.strictEqual(result.deleted, 0, "紐が切れて章が消えていないこと");
			assert.strictEqual(result.added, 0, "原文の章が新規ユニットとして生え直していないこと");
			assert.strictEqual(result.revisionsNeeded, 1, "改訂待ちが1件立つこと");
			assert.strictEqual(result.reviewsSuperseded, 1, "確認待ちから移したことを数えて伝えること");
		});

		test("そのあと人が確認を終えて印を外しても、英文が消えないこと（元の事故の再現手順）", async () => {
			const config = await adopt();
			reviseSource(sourceFile);
			await sync_CoreProc(sourceFile, targetFile, config);

			// 人が「レビュー済み」を押す（CodeLens・ツリー・LM Tool と同じ入口）
			await getFileHandler(targetFile).resolveNeed(targetFile, { needs: ["review"] });
			const afterResolve = await sync_CoreProc(sourceFile, targetFile, config);

			assert.strictEqual(targetBody(), TARGET, "英文がまるごと消え、日本語で置き直されるのが元の事故");
			assert.strictEqual(afterResolve.deleted, 0, "孤立と見なして削除していないこと");
			assert.ok(!targetBody().includes("インストール手順"), "訳文に原文の日本語が混入していないこと");
		});

		test("改訂を元に戻せば改訂待ちが消えること（据え置いた戻り先が正しい）", async () => {
			const config = await adopt();
			reviseSource(sourceFile);
			await sync_CoreProc(sourceFile, targetFile, config);

			undoRevision(sourceFile);
			const back = await sync_CoreProc(sourceFile, targetFile, config);

			assert.strictEqual(back.revisionsNeeded, 0, "戻り先まで戻ったら改訂すべき差分はもう無い");
			assert.strictEqual(targetBody(), TARGET);
		});

		test("原文を触っていない章の確認待ちはそのまま残ること（巻き添えにしない）", async () => {
			const config = await adopt();
			reviseSource(sourceFile);
			await sync_CoreProc(sourceFile, targetFile, config);

			const needs = targetNeeds();
			assert.strictEqual(
				needs.filter((need) => need === "review").length,
				2,
				`改訂した1章だけが移り、残り2章は確認待ちのまま（実際: ${needs.join(" / ")}）`,
			);
			assert.strictEqual(needs.filter((need) => need.startsWith("revise@")).length, 1);
		});
	});
}

suite("sync: 新規作成の経路では確認待ちが生まれないこと（前提の確認）", () => {
	let tempDir: string;

	setup(() => {
		Configuration.dispose();
		UnitRegistryManager.resetInstance();
		UnitStateStore.dispose();
		FileMutex.dispose();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-review-superseded-new-"));
		__vscodeMockWorkspaceRoot = tempDir;
		fs.mkdirSync(path.join(tempDir, "ja"), { recursive: true });
		fs.mkdirSync(path.join(tempDir, "en"), { recursive: true });
	});

	teardown(() => {
		Configuration.dispose();
		UnitRegistryManager.resetInstance();
		UnitStateStore.dispose();
		FileMutex.dispose();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("訳文が無いファイルは全ユニットが翻訳待ちで、改訂待ちへ移す件数は0であること", async () => {
		const mdaitDir = path.join(tempDir, ".mdait");
		fs.mkdirSync(mdaitDir, { recursive: true });
		const configPath = path.join(mdaitDir, "mdait.json");
		fs.writeFileSync(
			configPath,
			JSON.stringify({
				transPairs: [{ sourceDir: "ja", targetDir: "en", sourceLang: "ja", targetLang: "en" }],
				primaryLang: "ja",
				sync: { level: 3 },
			}),
			"utf-8",
		);
		const config = Configuration.getInstance();
		await config.initialize(configPath);
		UnitStateStore.getInstance().load(mdaitDir);
		const sourceFile = path.join(tempDir, "ja", "new.md");
		const targetFile = path.join(tempDir, "en", "new.md");
		fs.writeFileSync(sourceFile, SOURCE, "utf-8");

		await syncNew_CoreProc(sourceFile, targetFile, config);
		reviseSource(sourceFile);
		const result = await sync_CoreProc(sourceFile, targetFile, config);

		assert.strictEqual(result.reviewsSuperseded ?? 0, 0);
	});
});
