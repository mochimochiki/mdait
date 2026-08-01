/**
 * @file find-unit-end-line.test.ts
 * @description CodeLens のユニット終了行判定（findUnitEndLine）の external モード対応テスト。
 * external では本文にマーカーが無く、行スキャンだと常にファイル末尾になってしまうため、
 * resolveMarkerIO 経由のパース結果（ユニット行範囲）で終了行が決まることを検証する。
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type * as vscode from "vscode";
import { UnitStateStore } from "../../../../core/unit-state/unit-state-store";
import { Configuration } from "../../../../infra/config/configuration";
import { findUnitEndLine } from "../../../../ui/codelens/codelens-command";

declare let __vscodeMockWorkspaceRoot: string;

type MinimalDocument = Pick<vscode.TextDocument, "getText" | "lineAt" | "lineCount" | "uri">;

/** テスト用の最小 TextDocument を作る */
function makeDocument(absPath: string, text: string): MinimalDocument {
	const lines = text.split(/\r?\n/);
	return {
		uri: { fsPath: absPath },
		getText: () => text,
		lineCount: lines.length,
		lineAt: (i: number) => ({ text: lines[i as number] ?? "" }),
	} as unknown as MinimalDocument;
}

/** markers.mode を指定した mdait.json を書いて Configuration を初期化する */
async function initConfig(tempDir: string, mode: "embedded" | "external"): Promise<void> {
	const mdaitDir = path.join(tempDir, ".mdait");
	fs.mkdirSync(mdaitDir, { recursive: true });
	const configPath = path.join(mdaitDir, "mdait.json");
	fs.writeFileSync(
		configPath,
		JSON.stringify({
			transPairs: [{ sourceDir: "docs/en", targetDir: "docs/ja", sourceLang: "en", targetLang: "ja" }],
			primaryLang: "en",
			markers: { mode },
		}),
		"utf-8",
	);
	await Configuration.getInstance().initialize(configPath);
}

suite("findUnitEndLine（CodeLens ハイライト範囲の終了行判定）", () => {
	let tempDir: string;

	setup(() => {
		Configuration.dispose();
		UnitStateStore.dispose();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-cend-"));
		__vscodeMockWorkspaceRoot = tempDir;
	});

	teardown(() => {
		Configuration.dispose();
		UnitStateStore.dispose();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("external ではマーカーの無い本文でも次ユニットの手前で終了行が決まること（ファイル末尾に飛ばない）", async () => {
		await initConfig(tempDir, "external");
		UnitStateStore.getInstance().load(path.join(tempDir, ".mdait"));

		const targetAbs = path.join(tempDir, "docs/ja/guide.md");
		const text = ["# 見出し1", "", "本文1。", "", "## 見出し2", "", "本文2。", ""].join("\n");
		const doc = makeDocument(targetAbs, text);

		const endLine = findUnitEndLine(doc, 0);

		assert.ok(endLine < 4, `見出し2（4行目）より手前で終了する（実際: ${endLine}）`);
		assert.notStrictEqual(endLine, doc.lineCount - 1, "external でもファイル末尾へフォールバックしない");
	});

	test("embedded では従来どおり次のマーカー行の直前が終了行になること", async () => {
		await initConfig(tempDir, "embedded");

		const targetAbs = path.join(tempDir, "docs/ja/guide.md");
		const text = [
			"<!-- mdait aaaa1111 -->",
			"# 見出し1",
			"",
			"本文1。",
			"",
			"<!-- mdait bbbb2222 -->",
			"## 見出し2",
			"",
			"本文2。",
			"",
		].join("\n");
		const doc = makeDocument(targetAbs, text);

		assert.strictEqual(findUnitEndLine(doc, 0), 4, "次マーカー（5行目）の直前で終了する");
	});
});
