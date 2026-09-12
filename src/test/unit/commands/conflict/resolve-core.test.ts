/**
 * 競合の解決の本体のテスト（roadmap-v04）。
 *
 * ここが持つ約束は3つ。
 *
 * - **計画を作る段では1バイトも書かない**（承認の前に件数だけを見せる）
 * - **鍵の突き合わせで決まる分は、誰にも聞かずに片付く**
 * - **決まらない件が残った対象は1バイトも書かない**（半端に書くと残った件の片側が消える）
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	applyDecidedResolution,
	executeResolution,
	prepareResolution,
} from "../../../../commands/conflict/resolve-core";
import { collectMdaitConflicts } from "../../../../core/conflict/mdait-conflicts";
import { calculateHash } from "../../../../core/hash/hash-calculator";
import { TmxStore } from "../../../../core/tm/tmx-store";
import { Configuration } from "../../../../infra/config/configuration";
import type * as vscode from "vscode";

declare let __vscodeMockWorkspaceRoot: string;

const tuidOf = (primary: string) => calculateHash(primary, true);

function tu(primary: string, ja: string): string {
	return `<tu tuid="${tuidOf(primary)}"><tuv xml:lang="en"><seg>${primary}</seg></tuv><tuv xml:lang="ja"><seg>${ja}</seg></tuv></tu>`;
}

/** 同じ原文に別の訳が来た TMX（人の判断が要る形） */
function conflictedTmx(oursJa: string, theirsJa: string): string {
	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<tmx version="1.4">',
		"<body>",
		"<<<<<<< HEAD",
		tu("Hello", oursJa),
		"=======",
		tu("Hello", theirsJa),
		">>>>>>> theirs",
		"</body>",
		"</tmx>",
		"",
	].join("\n");
}

suite("競合の解決の本体", () => {
	let tempDir: string;
	let tmPath: string;
	let config: Configuration;

	setup(async () => {
		Configuration.dispose();
		TmxStore.resetInstance();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "resolve-core-"));
		__vscodeMockWorkspaceRoot = tempDir;
		fs.mkdirSync(path.join(tempDir, ".mdait"), { recursive: true });
		fs.mkdirSync(path.join(tempDir, "content", "en"), { recursive: true });
		fs.mkdirSync(path.join(tempDir, "content", "ja"), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, ".mdait", "mdait.json"),
			JSON.stringify({
				primaryLang: "en",
				transPairs: [{ source: "en", target: "ja", sourceDir: "content/en", targetDir: "content/ja" }],
			}),
			"utf-8",
		);
		config = Configuration.getInstance();
		await config.initialize();
		tmPath = config.getTmFilePath();
	});

	teardown(() => {
		Configuration.dispose();
		TmxStore.resetInstance();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	const paths = () => ({
		unitState: config.getUnitStateFilePath(),
		unitRegistry: config.getUnitRegistryFilePath(),
		tm: config.getTmFilePath(),
		terms: config.getTermsFilePath(),
	});

	test("計画を作る段では、1バイトも書かない", async () => {
		const content = conflictedTmx("こんにちは", "やあ");
		fs.writeFileSync(tmPath, content, "utf-8");
		const before = fs.statSync(tmPath).mtimeMs;

		const prepared = await prepareResolution(collectMdaitConflicts(paths()), config);

		assert.equal(prepared.summary.pendingTotal, 1);
		assert.equal(fs.readFileSync(tmPath, "utf-8"), content);
		assert.equal(fs.statSync(tmPath).mtimeMs, before);
	});

	test("鍵の突き合わせで決まる分は、誰にも聞かずに片付ける", async () => {
		// 別々の文を登録しただけの形。鍵の突き合わせで決定的に両方採れる
		const content = [
			'<?xml version="1.0" encoding="UTF-8"?>',
			'<tmx version="1.4">',
			"<body>",
			"<<<<<<< HEAD",
			tu("Hello", "こんにちは"),
			"=======",
			tu("Goodbye", "さようなら"),
			">>>>>>> theirs",
			"</body>",
			"</tmx>",
			"",
		].join("\n");
		fs.writeFileSync(tmPath, content, "utf-8");
		const prepared = await prepareResolution(collectMdaitConflicts(paths()), config);

		const outcomes = await executeResolution(prepared, config);

		assert.equal(outcomes.length, 1);
		assert.equal(outcomes[0].written, true);
		assert.equal(outcomes[0].remainingCount, 0);
		assert.equal(TmxStore.parseSide(fs.readFileSync(tmPath, "utf-8")).size, 2);
	});

	test("同じ鍵に別の値が来たら、残して1バイトも書かない", async () => {
		const content = conflictedTmx("こんにちは", "やあ");
		fs.writeFileSync(tmPath, content, "utf-8");
		const prepared = await prepareResolution(collectMdaitConflicts(paths()), config);

		const outcomes = await executeResolution(prepared, config);

		assert.equal(outcomes[0].remainingCount, 1);
		assert.equal(outcomes[0].written, false);
		assert.equal(fs.readFileSync(tmPath, "utf-8"), content);
	});

	test("競合が無ければ計画も空になる", async () => {
		const prepared = await prepareResolution(collectMdaitConflicts(paths()), config);

		assert.equal(prepared.summary.plans.length, 0);
	});

	test("読めなかった対象は、計画から落とさずに持ち帰る", async () => {
		// 壊れた1ファイルだけが競合していると、黙って落とせば「競合はありません」になる
		fs.writeFileSync(tmPath, "<<<<<<< HEAD\nこれは XML ではない <<< \n=======\nこれも違う\n>>>>>>> theirs\n", "utf-8");

		const prepared = await prepareResolution(collectMdaitConflicts(paths()), config);

		assert.equal(prepared.summary.plans.length, 0);
		assert.equal(prepared.summary.failures.length, 1, "読めなかったことが伝わっていない");
		assert.equal(prepared.summary.failures[0].kind, "tm");
	});

	test("取り消したら、手を付けなかった対象も未解決として返す", async () => {
		fs.writeFileSync(tmPath, conflictedTmx("こんにちは", "やあ"), "utf-8");
		const prepared = await prepareResolution(collectMdaitConflicts(paths()), config);
		const cancelled = { isCancellationRequested: true } as unknown as vscode.CancellationToken;

		const outcomes = await executeResolution(prepared, config, undefined, cancelled);

		assert.equal(outcomes.length, 1, "手を付けなかった対象が結果から消えている");
		assert.equal(outcomes[0].skipped, true);
		assert.ok(outcomes[0].remainingCount > 0, "残っていないことにされている");
		assert.equal(outcomes[0].written, false);
	});

	test("計画を作ったあとにファイルが変わっていたら、上書きしない", async () => {
		fs.writeFileSync(tmPath, conflictedTmx("こんにちは", "やあ"), "utf-8");
		const prepared = await prepareResolution(collectMdaitConflicts(paths()), config);
		const plan = prepared.summary.plans[0];

		// 確認ダイアログのあいだや、人が1件ずつ決めているあいだに、手で直した
		const edited = conflictedTmx("こんにちは（手で直した）", "やあ");
		fs.writeFileSync(tmPath, edited, "utf-8");

		const decided = new Map(plan.pending.map((item) => [item.key, "theirs" as const]));
		const outcome = await applyDecidedResolution(plan, prepared, config, decided);

		assert.equal(outcome.written, false);
		assert.ok(outcome.error, "変わったことが伝わっていない");
		assert.equal(fs.readFileSync(tmPath, "utf-8"), edited, "手で直した内容を消している");
	});
});
