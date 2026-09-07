/**
 * @file parse-tm-document.test.ts
 * @description tm-commit のファイル読取（parseTmDocument）の external マーカーモード対応テスト。
 * external では本文にマーカーが無いため、素の parse だと全ユニットがマーカー無し扱いになり
 * tm-commit が「対象0件」として沈黙するリグレッションを防ぐ。
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseTmDocument } from "../../../../commands/tm/command-commit";
import { isTmCommitTarget } from "../../../../commands/tm/commit-filter";
import { UnitStateStore } from "../../../../core/unit-state/unit-state-store";
import { Configuration } from "../../../../infra/config/configuration";
import { seat } from "../../helpers/unit-state";

declare let __vscodeMockWorkspaceRoot: string;

/** markers.mode を指定した mdait.json を書いて Configuration を初期化する */
async function initConfig(tempDir: string, mode: "embedded" | "external"): Promise<Configuration> {
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
	const config = Configuration.getInstance();
	await config.initialize(configPath);
	return config;
}

suite("parseTmDocument（tm-commit のマーカー読取経路）", () => {
	let tempDir: string;

	setup(() => {
		Configuration.dispose();
		UnitStateStore.dispose();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-tmparse-"));
		__vscodeMockWorkspaceRoot = tempDir;
	});

	teardown(() => {
		Configuration.dispose();
		UnitStateStore.dispose();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("external モードで unit-state のマーカーが attach され、tm-commit 対象ユニットが見つかること", async () => {
		const config = await initConfig(tempDir, "external");
		const targetRel = "docs/ja/guide.md";
		const targetAbs = path.join(tempDir, targetRel);
		fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
		// 本文にマーカーは無い（external モードの通常状態）
		fs.writeFileSync(targetAbs, "# タイトル\n\n確定済みの訳文。\n", "utf-8");

		const store = UnitStateStore.getInstance();
		store.load(path.join(tempDir, ".mdait"));
		store.setEntry({
			path: targetRel,
			kind: "unit" as const, seat: seat(0),
			level: 1,
			titleHash: "",
			hash: "tgt00001",
			from: "src00001",
			need: "",
		});

		const markdown = await parseTmDocument(targetAbs, config);

		assert.strictEqual(markdown.units.length, 1);
		assert.strictEqual(markdown.units[0].marker?.hash, "tgt00001");
		assert.strictEqual(markdown.units[0].marker?.from, "src00001");
		assert.strictEqual(
			markdown.units.filter(isTmCommitTarget).length,
			1,
			"external でも from 付き・need 無しユニットが TM 登録対象として検出される",
		);
	});

	test("embedded モードでは従来どおり本文の埋め込みマーカーが読まれること", async () => {
		const config = await initConfig(tempDir, "embedded");
		const targetRel = "docs/ja/guide.md";
		const targetAbs = path.join(tempDir, targetRel);
		fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
		fs.writeFileSync(
			targetAbs,
			"<!-- mdait tgt00001 from:src00001 -->\n# タイトル\n\n確定済みの訳文。\n",
			"utf-8",
		);

		const markdown = await parseTmDocument(targetAbs, config);

		assert.strictEqual(markdown.units.length, 1);
		assert.strictEqual(markdown.units[0].marker?.hash, "tgt00001");
		assert.strictEqual(markdown.units.filter(isTmCommitTarget).length, 1);
	});
});
