// 走らせる前の検証（validateForRun）のテスト。
//
// 「訳す先の言語が原文と同じ」「訳す先の言語が空」は、どの検査も素通りしていた。
// AI には「ja を ja へ訳せ」と伝わり、原文がそのまま返り、need は解除される。
// **課金だけされて何も訳されていないのに、状態としては翻訳済みになる。**
// 実行前に止める。

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Configuration } from "../../../../infra/config/configuration";

declare let __vscodeMockWorkspaceRoot: string;

suite("走らせる前の検証（validateForRun）", () => {
	let tempDir: string;
	let customPath: string;

	setup(() => {
		Configuration.dispose();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-vfr-"));
		__vscodeMockWorkspaceRoot = tempDir;
		fs.mkdirSync(path.join(tempDir, ".mdait"), { recursive: true });
		customPath = path.join(tempDir, ".mdait", "mdait.json");
	});

	teardown(() => {
		Configuration.dispose();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	async function load(pair: Record<string, unknown>): Promise<Configuration> {
		fs.writeFileSync(customPath, JSON.stringify({ transPairs: [pair], primaryLang: "ja" }), "utf-8");
		Configuration.dispose();
		const config = Configuration.getInstance();
		await config.initialize(customPath);
		return config;
	}

	test("原文と訳文の言語が同じなら、走らせる前に止める", async () => {
		const config = await load({ sourceDir: "docs", targetDir: "i18n/en", sourceLang: "ja", targetLang: "ja" });
		const error = config.validateForRun();
		assert.ok(error, "止まること（素通りすると課金だけされて何も訳されない）");
		assert.ok(error?.includes("ja"), `どの言語が重なっているかを言うこと: ${error}`);
	});

	test("訳す先の言語が空なら、走らせる前に止める", async () => {
		const config = await load({ sourceDir: "docs", targetDir: "i18n/en", sourceLang: "ja", targetLang: "" });
		const error = config.validateForRun();
		assert.ok(error, "止まること");
		assert.ok(error?.includes("targetLang"), `どの項目が空かを言うこと: ${error}`);
	});

	test("大文字小文字と前後の空白が違うだけの同じ言語も止める", async () => {
		const config = await load({ sourceDir: "docs", targetDir: "i18n/en", sourceLang: "EN", targetLang: " en " });
		assert.ok(config.validateForRun(), "書き方の違いで素通りしないこと");
	});

	test("言語が違っていれば通す", async () => {
		const config = await load({ sourceDir: "docs", targetDir: "i18n/en", sourceLang: "ja", targetLang: "en" });
		assert.strictEqual(config.validateForRun(), null);
	});
});
