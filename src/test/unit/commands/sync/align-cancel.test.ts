/**
 * 取り込み（adopt + AIアライン）の取り消しが、AI への送信を実際に止めることの回帰テスト。
 *
 * 背景: sync は AI を使わない処理だが、**AIアラインだけは使う**。ところが取り消しの合図が
 * sync へ渡っておらず（`alignMatchResult` の token に `undefined` を渡していた）、利用者が
 * 取り消しても最後のファイルまで AI を呼び続けていた。実測では、47ファイルの取り込みで
 * 取り消しの12秒後からさらに171秒ぶん呼び続けた。件数が増えるほど、止めたあとの請求が増える。
 */

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type * as vscode from "vscode";
import type { SectionAligner } from "../../../../commands/adopt/section-aligner";
import { sync_CoreProc } from "../../../../commands/sync/sync-command";
import { UnitRegistryManager } from "../../../../core/unit-registry/unit-registry-manager";
import { UnitStateStore } from "../../../../core/unit-state/unit-state-store";
import { Configuration } from "../../../../infra/config/configuration";
import { FileMutex } from "../../../../infra/workspace/file-mutex";

declare let __vscodeMockWorkspaceRoot: string;

const SOURCE = "# 製品ガイド\n\nこの製品の概要です。\n\n## インストール\n\n手順です。\n";
const TARGET = "# Product Guide\n\nThis is the product overview.\n\n## Installation\n\nThe steps.\n";

/** 呼ばれたことを記録する aligner。取り消し後は1度も呼ばれてはいけない */
function countingAligner(counter: { calls: number }): SectionAligner {
	return {
		align: async () => {
			counter.calls++;
			return { corrections: [], fallback: false, rounds: 1 };
		},
	} as unknown as SectionAligner;
}

/** 取り消し済み／未取り消しの合図 */
function tokenOf(cancelled: boolean): vscode.CancellationToken {
	return {
		isCancellationRequested: cancelled,
		onCancellationRequested: () => ({ dispose: () => {} }),
	} as unknown as vscode.CancellationToken;
}

suite("取り込み: 取り消したら AIアラインへ送らない", () => {
	let tempDir: string;
	let sourceFile: string;
	let targetFile: string;

	setup(() => {
		Configuration.dispose();
		UnitRegistryManager.resetInstance();
		UnitStateStore.dispose();
		FileMutex.dispose();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-align-cancel-"));
		__vscodeMockWorkspaceRoot = tempDir;
		fs.mkdirSync(path.join(tempDir, "ja"), { recursive: true });
		fs.mkdirSync(path.join(tempDir, "en"), { recursive: true });
		sourceFile = path.join(tempDir, "ja", "doc.md");
		targetFile = path.join(tempDir, "en", "doc.md");
		fs.writeFileSync(sourceFile, SOURCE, "utf-8");
		fs.writeFileSync(targetFile, TARGET, "utf-8");
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
				sync: { level: 3 },
			}),
			"utf-8",
		);
		const config = Configuration.getInstance();
		await config.initialize(configPath);
		UnitStateStore.getInstance().load(mdaitDir);
		return config;
	}

	test("取り消し済みなら aligner を1度も呼ばないこと", async () => {
		const config = await bootstrap();
		const counter = { calls: 0 };

		await sync_CoreProc(sourceFile, targetFile, config, {
			adopt: true,
			align: true,
			token: tokenOf(true),
		}, countingAligner(counter));

		assert.strictEqual(counter.calls, 0, "取り消したのに AI へ送っている");
	});

	test("取り消していなければ aligner を呼ぶこと（取り消しの確認が経路ごと殺していない）", async () => {
		const config = await bootstrap();
		const counter = { calls: 0 };

		await sync_CoreProc(sourceFile, targetFile, config, {
			adopt: true,
			align: true,
			token: tokenOf(false),
		}, countingAligner(counter));

		assert.strictEqual(counter.calls, 1, "ふつうの取り込みで AIアラインが走っていない");
	});

	test("取り消しても取り込み自体は済み、原稿は壊れないこと", async () => {
		const config = await bootstrap();

		const result = await sync_CoreProc(sourceFile, targetFile, config, {
			adopt: true,
			align: true,
			token: tokenOf(true),
		}, countingAligner({ calls: 0 }));

		assert.ok((result.adopted ?? 0) > 0, "位置ベースの取り込みまで止まっている");
		assert.ok(fs.readFileSync(targetFile, "utf-8").includes("This is the product overview."));
	});
});
