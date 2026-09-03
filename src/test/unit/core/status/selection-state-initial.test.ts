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

		await selection.initialize(memoryContext({ "mdait.activeTargets": ["fr"], "mdait.knownTargets": ["en", "fr"] }));

		assert.deepStrictEqual([...selection.getActiveKeys()], ["fr"]);
	});

	test("この仕組みが入る前から使っている人の選択を、勝手に広げない", async () => {
		// knownTargets の覚えが無い回。ここで広げると、本人が絞り込んだ設定が黙って戻る
		await loadConfig();
		const selection = SelectionState.getInstance();

		await selection.initialize(memoryContext({ "mdait.activeTargets": ["fr"] }));

		assert.deepStrictEqual([...selection.getActiveKeys()], ["fr"]);
	});

	test("初期化のときに設定へ増えていた言語は、その場で対象になる", async () => {
		// 覚え（knownTargets）に無い＝本人が外したのではなく、あとから書き足されたもの
		await loadConfig();
		const selection = SelectionState.getInstance();

		await selection.initialize(memoryContext({ "mdait.activeTargets": ["en"], "mdait.knownTargets": ["en"] }));

		assert.deepStrictEqual([...selection.getActiveKeys()].sort(), ["en", "fr"]);
	});

	test("動いている最中に書き足した言語も、次の同期から対象になる", async () => {
		// 初回だけを直しても、あとから言語を増やした人は同じ無言の取りこぼしを踏む
		// （実測: 拡張を開き直すまで、その言語のフォルダが作られなかった）
		await loadConfig();
		const selection = SelectionState.getInstance();
		await selection.initialize(memoryContext({ "mdait.activeTargets": ["en"], "mdait.knownTargets": ["en", "fr"] }));
		assert.deepStrictEqual([...selection.getActiveKeys()], ["en"], "前提: en だけを選んでいる");

		selection.reconcileWith([
			{ sourceDir: "ja", targetDir: "en", sourceLang: "ja", targetLang: "en" },
			{ sourceDir: "ja", targetDir: "fr", sourceLang: "ja", targetLang: "fr" },
			{ sourceDir: "ja", targetDir: "de", sourceLang: "ja", targetLang: "de" },
		]);

		assert.deepStrictEqual([...selection.getActiveKeys()].sort(), ["de", "en"], "新しい de だけが増える");
	});

	test("本人が外した言語は、追随のたびに戻ってこない", async () => {
		await loadConfig();
		const selection = SelectionState.getInstance();
		await selection.initialize(memoryContext({ "mdait.activeTargets": ["en"], "mdait.knownTargets": ["en", "fr"] }));

		const pairs = [
			{ sourceDir: "ja", targetDir: "en", sourceLang: "ja", targetLang: "en" },
			{ sourceDir: "ja", targetDir: "fr", sourceLang: "ja", targetLang: "fr" },
		];
		selection.reconcileWith(pairs);
		selection.reconcileWith(pairs);

		assert.deepStrictEqual([...selection.getActiveKeys()], ["en"], "外した fr が戻らないこと");
	});

	test("設定から言語が消えても、選択が空になって何も動かなくならない", async () => {
		await loadConfig();
		const selection = SelectionState.getInstance();
		await selection.initialize(memoryContext({ "mdait.activeTargets": ["fr"], "mdait.knownTargets": ["en", "fr"] }));

		selection.reconcileWith([{ sourceDir: "ja", targetDir: "en", sourceLang: "ja", targetLang: "en" }]);

		assert.deepStrictEqual([...selection.getActiveKeys()], ["en"]);
	});
});
