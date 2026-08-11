// withFileMutation がストア全体の排他（unit-state-lock）を取ることの検証。
//
// need の解除・ユニット削除・Keep も「ストアを読み込んでから書き戻す」区間を持つ。
// syncCommand は開始時に load() を無条件に呼び、終了時に save() するので、この区間と
// 重なると書き換えが読み捨てられるか上書きで消える。どちらも無言で起きる。
// （P02 で sync 側にだけ排他を入れたため「守られている」ように見えていた穴）

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { keepUnitsAsIndependent } from "../../../../commands/markers/keep-unit";
import { resolveNeedForFile } from "../../../../commands/markers/resolve-need";
import { UnitStateStore } from "../../../../core/unit-state/unit-state-store";
import { Configuration } from "../../../../infra/config/configuration";
import { FileMutex } from "../../../../infra/workspace/file-mutex";
import { acquireUnitStateLock, resetUnitStateLock } from "../../../../infra/workspace/unit-state-lock";

declare let __vscodeMockWorkspaceRoot: string;

/** マクロタスクを何回か回して「進めるなら進んでいる」状態にする */
async function letItRun(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

suite("withFileMutation のストア排他", () => {
	let tempDir: string;
	let targetFile: string;

	const TARGET_CONTENT = `## Section A

Content A.

## Section B

Content B.
`;

	async function initConfig(): Promise<Configuration> {
		const mdaitDir = path.join(tempDir, ".mdait");
		fs.mkdirSync(mdaitDir, { recursive: true });
		fs.writeFileSync(
			path.join(mdaitDir, "mdait.json"),
			JSON.stringify({
				transPairs: [{ sourceDir: "ja", targetDir: "en", sourceLang: "ja", targetLang: "en" }],
				primaryLang: "ja",
				markers: { mode: "external" },
			}),
			"utf-8",
		);
		return await Configuration.getInstance().initialize(path.join(mdaitDir, "mdait.json"));
	}

	/** 訳文と、その need 付きの行を用意する */
	function seedTarget(): void {
		fs.mkdirSync(path.join(tempDir, "en"), { recursive: true });
		fs.writeFileSync(targetFile, TARGET_CONTENT, "utf-8");
		const store = UnitStateStore.getInstance();
		store.ensureLoaded(path.join(tempDir, ".mdait"));
		store.setEntry({
			path: "en/doc.md",
			order: 0,
			level: 2,
			titleHash: "",
			hash: "",
			from: "srcA",
			need: "verify-deletion",
		});
		store.save(path.join(tempDir, ".mdait"));
	}

	setup(() => {
		Configuration.dispose();
		UnitStateStore.dispose();
		FileMutex.dispose();
		resetUnitStateLock();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-mutation-lock-"));
		__vscodeMockWorkspaceRoot = tempDir;
		targetFile = path.join(tempDir, "en", "doc.md");
	});

	teardown(() => {
		Configuration.dispose();
		UnitStateStore.dispose();
		FileMutex.dispose();
		resetUnitStateLock();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("ストアのロックを誰かが持っている間、Keep は書き換えを始めないこと", async () => {
		const config = await initConfig();
		seedTarget();

		const held = await acquireUnitStateLock();
		let settled = false;
		const pending = keepUnitsAsIndependent(targetFile, config).then(() => {
			settled = true;
		});

		await letItRun();
		assert.strictEqual(settled, false, "sync がストアを掴んでいる間は待つ");

		held.release();
		await pending;
		assert.strictEqual(settled, true, "解放されたら進む");
	});

	test("ストアのロックを誰かが持っている間、need の解除は書き換えを始めないこと", async () => {
		const config = await initConfig();
		seedTarget();

		const held = await acquireUnitStateLock();
		let settled = false;
		const pending = resolveNeedForFile(targetFile, config, {}).then(() => {
			settled = true;
		});

		await letItRun();
		assert.strictEqual(settled, false);

		held.release();
		await pending;
		assert.strictEqual(settled, true);
	});
});
