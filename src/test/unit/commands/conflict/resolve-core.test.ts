/**
 * 競合の解決の本体のテスト（roadmap-v04 P02）。
 *
 * ここが持つ約束は、P02 のゲートそのものである。
 *
 * - **計画を作る段では1バイトも書かず、AI も呼ばない**（UX-P4: コストは承認の前に見える）
 * - **API キーが無くても止まらない**（鍵の突き合わせで決まる分は片付く）
 * - **決まらない件が残った対象は1バイトも書かない**
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ConflictJudge } from "../../../../commands/conflict/conflict-judge";
import { executeResolution, prepareResolution } from "../../../../commands/conflict/resolve-core";
import { collectMdaitConflicts } from "../../../../core/conflict/mdait-conflicts";
import { calculateHash } from "../../../../core/hash/hash-calculator";
import { TmxStore } from "../../../../core/tm/tmx-store";
import { Configuration } from "../../../../infra/config/configuration";
import type { AIMessage, AIService } from "../../../../infra/llm/ai-service";
import type { PromptParts } from "../../../../prompts";

declare let __vscodeMockWorkspaceRoot: string;

/** 呼ばれたことを数える偽の AI */
class CountingAi implements AIService {
	calls = 0;
	constructor(private readonly reply: string) {}
	async sendMessage(_system: string, _messages: AIMessage[]): Promise<string> {
		this.calls++;
		return this.reply;
	}
}

const parts = (variables: Record<string, string | undefined>): PromptParts => ({
	system: "SYSTEM",
	userContext: `USER ${variables.conflicts ?? ""}`,
	isLegacy: false,
});

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

	test("計画を作る段では、AI を1回も呼ばない", async () => {
		// UX-P4: 承認をもらう前に費用が出てはいけない
		fs.writeFileSync(tmPath, conflictedTmx("こんにちは", "やあ"), "utf-8");
		const ai = new CountingAi('{"decisions":[]}');

		await prepareResolution(collectMdaitConflicts(paths()), config);

		assert.equal(ai.calls, 0);
	});

	test("AI が無くても止まらず、決まる分だけ片付ける", async () => {
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

		const { outcomes } = await executeResolution(prepared, config, undefined, undefined);

		assert.equal(outcomes.length, 1);
		assert.equal(outcomes[0].written, true);
		assert.equal(outcomes[0].remainingCount, 0);
		assert.equal(TmxStore.parseSide(fs.readFileSync(tmPath, "utf-8")).size, 2);
	});

	test("AI が無ければ、決まらない件は残して1バイトも書かない", async () => {
		const content = conflictedTmx("こんにちは", "やあ");
		fs.writeFileSync(tmPath, content, "utf-8");
		const prepared = await prepareResolution(collectMdaitConflicts(paths()), config);

		const { outcomes } = await executeResolution(prepared, config, undefined, undefined);

		assert.equal(outcomes[0].remainingCount, 1);
		assert.equal(outcomes[0].written, false);
		assert.equal(fs.readFileSync(tmPath, "utf-8"), content);
	});

	test("AI が決めれば、書き戻して競合マーカーが消える", async () => {
		fs.writeFileSync(tmPath, conflictedTmx("こんにちは", "やあ"), "utf-8");
		const prepared = await prepareResolution(collectMdaitConflicts(paths()), config);
		const ai = new CountingAi('{"decisions":[{"index":1,"side":"theirs","reason":"新しいほう"}]}');
		const judge = new ConflictJudge(ai, (_id, v) => parts(v));

		const { outcomes, reasons } = await executeResolution(prepared, config, judge, undefined);

		assert.equal(ai.calls, 1);
		assert.equal(outcomes[0].decidedCount, 1);
		assert.equal(outcomes[0].written, true);
		const after = fs.readFileSync(tmPath, "utf-8");
		assert.doesNotMatch(after, /^<{7}|^={7}|^>{7}/m);
		assert.equal(TmxStore.parseSide(after).get(tuidOf("Hello"))?.variants.get("ja")?.text, "やあ");
		assert.equal([...reasons.values()][0], "新しいほう");
	});

	test("AI が迷えば、書かずに残す", async () => {
		const content = conflictedTmx("こんにちは", "やあ");
		fs.writeFileSync(tmPath, content, "utf-8");
		const prepared = await prepareResolution(collectMdaitConflicts(paths()), config);
		const ai = new CountingAi('{"decisions":[{"index":1,"side":"unsure"}]}');
		const judge = new ConflictJudge(ai, (_id, v) => parts(v));

		const { outcomes } = await executeResolution(prepared, config, judge, undefined);

		assert.equal(outcomes[0].remainingCount, 1);
		assert.equal(outcomes[0].written, false);
		assert.equal(fs.readFileSync(tmPath, "utf-8"), content);
	});

	test("競合が無ければ計画も空になる", async () => {
		const prepared = await prepareResolution(collectMdaitConflicts(paths()), config);

		assert.equal(prepared.summary.plans.length, 0);
	});
});
