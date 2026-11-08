/**
 * @file status-collector-external-load.test.ts
 * @description
 *   external では、起動した直後（unit-state をまだ誰も読んでいない）に組んだ一覧にも
 *   マーカーが載ることの検証。
 *
 *   回帰固定: 読み込みが sync・翻訳の中にしか無く、起動直後の一覧は全ファイルが
 *   「ユニット0」になっていた。一覧を見て動く TM 登録と用語検出は対象0件で何もせずに
 *   終わり、状態の取得も 0 ユニットと答えた（Lab で実測）。
 */

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getFileHandler } from "../../../../commands/file-handler/file-handler-factory";
import { StatusCollector } from "../../../../commands/file-handler/status-collector";
import { UnitStateStore } from "../../../../core/unit-state/unit-state-store";
import { Configuration } from "../../../../infra/config/configuration";

declare let __vscodeMockWorkspaceRoot: string;

suite("external: 起動直後の一覧にも unit-state のマーカーが載る", () => {
	let tempDir: string;
	let mdaitDir: string;

	setup(async () => {
		Configuration.dispose();
		UnitStateStore.dispose();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-collector-load-"));
		__vscodeMockWorkspaceRoot = tempDir;
		mdaitDir = path.join(tempDir, ".mdait");
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
		await Configuration.getInstance().initialize(path.join(mdaitDir, "mdait.json"));
		fs.mkdirSync(path.join(tempDir, "ja"), { recursive: true });
		fs.writeFileSync(path.join(tempDir, "ja", "doc.md"), "# 章1\n\n本文1。\n\n# 章2\n\n本文2。\n", "utf-8");
	});

	teardown(() => {
		Configuration.dispose();
		UnitStateStore.dispose();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("unit-state を読む前に組んだ一覧でも、訳文のユニットにマーカーが載ること", async () => {
		const source = path.join(tempDir, "ja", "doc.md");
		const target = path.join(tempDir, "en", "doc.md");
		UnitStateStore.getInstance().load(mdaitDir);
		await getFileHandler(target).syncNew(source, target);
		UnitStateStore.getInstance().save(mdaitDir);
		assert.ok(fs.existsSync(path.join(mdaitDir, "unit-state")), "前提: unit-state がディスクにある");

		// 起動し直した状態（メモリ上のストアは空で、まだ誰も読んでいない）
		UnitStateStore.dispose();

		const tree = await new StatusCollector().buildStatusItemTree();

		const units = tree.getFile(target)?.children ?? [];
		assert.strictEqual(units.length, 2);
		// マーカーが載っていれば、どのユニットにも hash と翻訳待ちの印がある。載っていないと空になり、
		// 一覧から原文を引く TM 登録が「原文のユニットを引けない」で全件飛ばしていた
		for (const unit of units) {
			assert.ok(unit.unitHash, "ユニットの hash が unit-state から載ること");
			assert.strictEqual(unit.needFlag, "translate");
		}
	});
});
