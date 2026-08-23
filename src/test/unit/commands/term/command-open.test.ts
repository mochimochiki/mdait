/**
 * @file command-open.test.ts
 * @description openTermCommand の「用語集がまだ無いとき」の案内経路のテスト。
 *
 * 実測で見つかった欠陥の回帰固定:
 *  1. 案内のボタンから、登録されていないコマンド ID（mdait.term.detect.file）を
 *     実行していた。実 Extension Host では "command ... not found" になっていた。
 *  2. その実行を「用語集を開く」の try/catch の中で待っていたため、更新側の失敗が
 *     「用語集ファイルを開けませんでした」という無関係な文言で報告されていた。
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openTermCommand } from "../../../../commands/term/command-open";
import { StatusItemType } from "../../../../core/status/status-item";
import { Configuration } from "../../../../infra/config/configuration";

declare let __vscodeMockWorkspaceRoot: string;
declare let __vscodeMockShownMessages: Array<{ level: string; message: string; items: string[] }> | undefined;
declare let __vscodeMockMessageChoice: unknown;
declare let __vscodeMockCommandHandlers: Record<string, (...args: unknown[]) => unknown> | undefined;
declare let __vscodeMockActiveTextEditor: unknown;

const MDAIT_JSON = JSON.stringify({
	transPairs: [{ sourceLang: "ja", sourceDir: "content/ja", targetLang: "en", targetDir: "content/en" }],
	primaryLang: "ja",
	terms: { filename: "terms.csv" },
});

suite("openTermCommand", () => {
	let tempDir: string;
	/** 実行された mdait.term.update の引数（実行されていなければ undefined） */
	let updateArgs: unknown[] | undefined;

	setup(() => {
		Configuration.dispose();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-term-open-"));
		fs.mkdirSync(path.join(tempDir, ".mdait"), { recursive: true });
		fs.writeFileSync(path.join(tempDir, ".mdait", "mdait.json"), MDAIT_JSON);
		__vscodeMockWorkspaceRoot = tempDir;
		__vscodeMockShownMessages = [];
		// 案内のボタン「Detect Terms」を押した状態にする
		__vscodeMockMessageChoice = "Detect Terms";
		__vscodeMockActiveTextEditor = {
			document: { uri: { fsPath: path.join(tempDir, "content", "ja", "guide.md") } },
		};
		updateArgs = undefined;
		// 実 VS Code と同じく、ここに無い ID の実行は "command ... not found" で失敗する。
		// 登録済みのコマンドだけを並べることで、存在しない ID を踏んだら赤くなる
		__vscodeMockCommandHandlers = {
			"mdait.term.update": (...args: unknown[]) => {
				updateArgs = args;
			},
		};
	});

	teardown(() => {
		Configuration.dispose();
		__vscodeMockShownMessages = undefined;
		__vscodeMockMessageChoice = undefined;
		__vscodeMockCommandHandlers = undefined;
		__vscodeMockActiveTextEditor = undefined;
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("用語集が無いときの案内のボタンからは、登録済みの用語集更新コマンドが起動する", async () => {
		await openTermCommand();

		assert.ok(updateArgs, "mdait.term.update が実行されていること");
		assert.deepEqual(updateArgs?.[0], {
			type: StatusItemType.File,
			filePath: path.join(tempDir, "content", "ja", "guide.md"),
		});
	});

	test("用語集の更新が失敗しても『用語集ファイルを開けませんでした』とは報告しない", async () => {
		__vscodeMockCommandHandlers = {
			"mdait.term.update": () => {
				throw new Error("glossary update blew up");
			},
		};

		await assert.rejects(openTermCommand(), /glossary update blew up/);

		const misreported = (__vscodeMockShownMessages ?? []).filter((m) =>
			m.message.startsWith("Failed to open glossary file"),
		);
		assert.equal(misreported.length, 0, "開く失敗として報告していないこと");
	});

	test("案内のボタンを押さなかったときは何も起動しない", async () => {
		__vscodeMockMessageChoice = undefined;

		await openTermCommand();

		assert.equal(updateArgs, undefined, "コマンドを実行していないこと");
	});

	test("用語集があるときは開くだけで、用語集更新コマンドは起動しない", async () => {
		fs.writeFileSync(path.join(tempDir, ".mdait", "terms.csv"), "context,ja,en\n");

		await openTermCommand();

		assert.equal(updateArgs, undefined, "コマンドを実行していないこと");
		assert.equal(__vscodeMockShownMessages?.length, 0, "案内の通知を出していないこと");
	});
});
