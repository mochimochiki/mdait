// 初回の対象言語の選び方（SelectionState.initialize）のテスト。
//
// 以前は「先頭のターゲットを1つ」だけ選んでいた。2言語目を設定に書いた人は、
// sync してもその言語のフォルダが作られず、通知にも「素通りした」と出なかった。
// 設定に書いたことは本人の宣言なので、狭めるのは明示の操作だけにする。

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SelectionState } from "../../../../core/status/selection-state";
import { Configuration } from "../../../../infra/config/configuration";

declare let __vscodeMockWorkspaceRoot: string;

/** workspaceState だけを持つ、記憶が空の擬似 ExtensionContext */
function memoryContext(seed: Record<string, unknown> = {}) {
	const store: Record<string, unknown> = { ...seed };
	return {
		workspaceState: {
			get: (key: string) => store[key],
			update: (key: string, value: unknown) => {
				store[key] = value;
				return Promise.resolve();
			},
		},
	} as never;
}

suite("初回に選ぶ対象言語", () => {
	let tempDir: string;
	let configPath: string;

	setup(() => {
		Configuration.dispose();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-sel-"));
		__vscodeMockWorkspaceRoot = tempDir;
		fs.mkdirSync(path.join(tempDir, ".mdait"), { recursive: true });
		configPath = path.join(tempDir, ".mdait", "mdait.json");
	});

	teardown(() => {
		Configuration.dispose();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	async function loadConfig(): Promise<void> {
		fs.writeFileSync(
			configPath,
			JSON.stringify({
				transPairs: [
					{ sourceDir: "ja", targetDir: "en", sourceLang: "ja", targetLang: "en" },
					{ sourceDir: "ja", targetDir: "fr", sourceLang: "ja", targetLang: "fr" },
				],
				primaryLang: "ja",
			}),
			"utf-8",
		);
		const config = Configuration.getInstance();
		await config.initialize(configPath);
	}

	test("前回の記憶が無ければ、設定した対象言語を全部選ぶ", async () => {
		await loadConfig();
		const selection = SelectionState.getInstance();

		await selection.initialize(memoryContext());

		assert.deepStrictEqual(
			[...selection.getActiveKeys()].sort(),
			["en", "fr"],
			"先頭1つだけだと、2言語目が黙って同期も翻訳もされない",
		);
	});

	test("前回の選択が残っていれば、それを尊重する（狭めるのは明示の操作だけ）", async () => {
		await loadConfig();
		const selection = SelectionState.getInstance();

		await selection.initialize(memoryContext({ "mdait.activeTargets": ["fr"] }));

		assert.deepStrictEqual([...selection.getActiveKeys()], ["fr"]);
	});
});
