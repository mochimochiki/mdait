/**
 * @file ai-stats-logger.test.ts
 * @description ログの追記が、置き場ごと消えたあとでも続けられるかを確かめる。
 *
 * `.mdait/logs` は `.mdait/.gitignore` に載っていて git の管理外なので、
 * `git clean -xdf` や掃除スクリプトで消えることがある。消えたあとも
 * 拡張は動いたままで、ログの置き場は最初の1回しか用意していなかったため、
 * 以降の追記が ENOENT で静かに落ちて、AI とのやり取りが一切残らなくなっていた。
 */
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Configuration } from "../../../../infra/config/configuration";
import { AIStatsLogger } from "../../../../infra/llm/ai-stats-logger";

declare let __vscodeMockWorkspaceRoot: string;

/** 詳細ログの1件分 */
function detailedRecord(content: string) {
	return {
		timestamp: "2026-08-23 22:00:00",
		provider: "openai",
		model: "test-model",
		request: { systemPrompt: "system", messages: [{ role: "user" as const, content }] },
		response: { content: "done", durationMs: 1 },
		status: "success" as const,
	};
}

/** 統計ログの1件分 */
function statsRecord() {
	return {
		timestamp: "2026-08-23 22:00:00",
		provider: "openai",
		model: "test-model",
		inputChars: 10,
		outputChars: 20,
		durationMs: 30,
		status: "success" as const,
	};
}

suite("AIStatsLogger", () => {
	let tempDir: string;
	let previousRoot: string | undefined;

	setup(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-ai-stats-logger-"));
		previousRoot = __vscodeMockWorkspaceRoot;
		__vscodeMockWorkspaceRoot = tempDir;
		Configuration.dispose();
		const config = Configuration.getInstance();
		config.ai.debug = { enableStatsLogging: true, logPromptAndResponse: true };
		AIStatsLogger.reset();
	});

	teardown(() => {
		AIStatsLogger.reset();
		Configuration.dispose();
		__vscodeMockWorkspaceRoot = previousRoot as string;
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("詳細ログの置き場が消されても、次の追記でディレクトリごと作り直して書ける", async () => {
		const logger = AIStatsLogger.getInstance();
		const logFile = path.join(tempDir, ".mdait", "logs", "ai-detailed.log");

		await logger.logDetailed(detailedRecord("1回目"));
		assert.ok(fs.existsSync(logFile), "1回目の追記でログファイルができること");

		// git clean などで置き場ごと消える状況を再現する（拡張は動いたまま）
		fs.rmSync(path.join(tempDir, ".mdait", "logs"), { recursive: true, force: true });

		await logger.logDetailed(detailedRecord("2回目"));
		assert.ok(fs.existsSync(logFile), "消えたあとの追記でもログファイルが作り直されること");
		const lines = fs.readFileSync(logFile, "utf-8").trim().split("\n");
		assert.strictEqual(lines.length, 1, "作り直したあとは2回目の1件だけが残ること");
		assert.ok(lines[0].includes("2回目"), "2回目の内容が書けていること");
	});

	test("統計ログの置き場が消されても、次の追記でディレクトリごと作り直して書ける", async () => {
		const logger = AIStatsLogger.getInstance();
		const logFile = path.join(tempDir, ".mdait", "logs", "ai-stats.log");

		await logger.log(statsRecord());
		assert.ok(fs.existsSync(logFile), "1回目の追記でログファイルができること");

		fs.rmSync(path.join(tempDir, ".mdait", "logs"), { recursive: true, force: true });

		await logger.log(statsRecord());
		assert.ok(fs.existsSync(logFile), "消えたあとの追記でもログファイルが作り直されること");
		const lines = fs.readFileSync(logFile, "utf-8").trim().split("\n");
		assert.strictEqual(lines.length, 2, "作り直したあとは見出し行と1件だけが残ること");
		assert.ok(lines[0].startsWith("timestamp\t"), "見出し行が書き直されていること");
	});

	test("置き場が残っているあいだは、追記が積み上がる", async () => {
		const logger = AIStatsLogger.getInstance();
		const logFile = path.join(tempDir, ".mdait", "logs", "ai-detailed.log");

		await logger.logDetailed(detailedRecord("1件目"));
		await logger.logDetailed(detailedRecord("2件目"));

		const lines = fs.readFileSync(logFile, "utf-8").trim().split("\n");
		assert.strictEqual(lines.length, 2, "2件とも残ること");
	});
});
