/**
 * 人が1件ずつ決める逃げ道のテスト（roadmap-v04 P03）。
 *
 * ここが持つ約束は3つ。**AI を1回も呼ばないこと**（API キーが無い人の道）、
 * **決まらない件が残っているうちは1バイトも書かないこと**、そして
 * **最後の1件が決まったらまとめて書き戻すこと**である。
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	decisionOf,
	decisionsFor,
	forgetAllDecisions,
	forgetDecisions,
	rememberDecision,
} from "../../../../commands/conflict/conflict-decisions";
import { applyDecidedResolution, prepareResolution } from "../../../../commands/conflict/resolve-core";
import { collectMdaitConflicts } from "../../../../core/conflict/mdait-conflicts";
import { calculateHash } from "../../../../core/hash/hash-calculator";
import { TmxStore } from "../../../../core/tm/tmx-store";
import { Configuration } from "../../../../infra/config/configuration";

declare let __vscodeMockWorkspaceRoot: string;

const tuidOf = (primary: string) => calculateHash(primary, true);

/** 決めかけの寿命は、計画を作ったときのファイルの見た目に結び付いている */
const S = "stamp";
const stampOf = (prepared: { stamps: Map<string, string> }, filePath: string): string => {
	const stamp = prepared.stamps.get(filePath);
	assert.ok(stamp, "計画がファイルの見た目を覚えていない");
	return stamp;
};

function tu(primary: string, ja: string): string {
	return `<tu tuid="${tuidOf(primary)}"><tuv xml:lang="en"><seg>${primary}</seg></tuv><tuv xml:lang="ja"><seg>${ja}</seg></tuv></tu>`;
}

/** 2件とも「同じ原文に別の訳」で衝突している TMX */
function twoConflicts(): string {
	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<tmx version="1.4">',
		"<body>",
		"<<<<<<< HEAD",
		tu("Hello", "こんにちは"),
		tu("Bye", "さらば"),
		"=======",
		tu("Hello", "やあ"),
		tu("Bye", "またね"),
		">>>>>>> theirs",
		"</body>",
		"</tmx>",
		"",
	].join("\n");
}

suite("人が1件ずつ決める", () => {
	let tempDir: string;
	let tmPath: string;
	let config: Configuration;

	setup(async () => {
		Configuration.dispose();
		TmxStore.resetInstance();
		forgetAllDecisions();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "take-side-"));
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
		forgetAllDecisions();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	const paths = () => ({
		unitState: config.getUnitStateFilePath(),
		unitRegistry: config.getUnitRegistryFilePath(),
		tm: config.getTmFilePath(),
		terms: config.getTermsFilePath(),
	});

	suite("判断の預かり", () => {
		test("決めたぶんを覚えている", () => {
			rememberDecision("/a", S, "k1", "ours");

			assert.equal(decisionOf("/a", S, "k1"), "ours");
			assert.equal(decisionsFor("/a", S).size, 1);
		});

		test("決め直せる", () => {
			rememberDecision("/a", S, "k1", "ours");
			rememberDecision("/a", S, "k1", "theirs");

			assert.equal(decisionOf("/a", S, "k1"), "theirs");
		});

		test("ファイルごとに分かれている", () => {
			rememberDecision("/a", S, "k1", "ours");
			rememberDecision("/b", S, "k1", "theirs");

			assert.equal(decisionOf("/a", S, "k1"), "ours");
			assert.equal(decisionOf("/b", S, "k1"), "theirs");
		});

		test("捨てれば残らない（書き戻したあと・ファイルが外から変わったあと）", () => {
			rememberDecision("/a", S, "k1", "ours");
			forgetDecisions("/a");

			assert.equal(decisionOf("/a", S, "k1"), undefined);
		});
	});

	suite("1件ずつ決めて、最後にまとめて書く", () => {
		test("1件だけ決めた時点では、1バイトも書かない", async () => {
			const content = twoConflicts();
			fs.writeFileSync(tmPath, content, "utf-8");
			const prepared = await prepareResolution(collectMdaitConflicts(paths()), config);
			const plan = prepared.summary.plans[0];
			assert.equal(plan.pending.length, 2);

			rememberDecision(tmPath, stampOf(prepared, tmPath), plan.pending[0].key, "ours");
			const outcome = await applyDecidedResolution(plan, prepared, config, decisionsFor(tmPath, stampOf(prepared, tmPath)));

			assert.equal(outcome.written, false);
			assert.equal(outcome.remainingCount, 1);
			assert.equal(fs.readFileSync(tmPath, "utf-8"), content, "半端に書き戻している");
		});

		test("全件が決まったら書き戻し、決めたとおりになる", async () => {
			fs.writeFileSync(tmPath, twoConflicts(), "utf-8");
			const prepared = await prepareResolution(collectMdaitConflicts(paths()), config);
			const plan = prepared.summary.plans[0];

			for (const item of plan.pending) {
				// 原文が Hello の件は「こちら」、Bye の件は「あちら」を採る
				rememberDecision(tmPath, stampOf(prepared, tmPath), item.key, item.label === "Hello" ? "ours" : "theirs");
			}
			const outcome = await applyDecidedResolution(plan, prepared, config, decisionsFor(tmPath, stampOf(prepared, tmPath)));

			assert.equal(outcome.written, true);
			assert.equal(outcome.decidedCount, 2);
			const back = TmxStore.parseSide(fs.readFileSync(tmPath, "utf-8"));
			assert.equal(back.get(tuidOf("Hello"))?.variants.get("ja")?.text, "こんにちは");
			assert.equal(back.get(tuidOf("Bye"))?.variants.get("ja")?.text, "またね");
			assert.doesNotMatch(fs.readFileSync(tmPath, "utf-8"), /^<{7}|^={7}|^>{7}/m);
		});

		test("AI を1回も通さずに、全件を解決できる", async () => {
			// API キーが無い人の道。`applyDecidedResolution` は AI を受け取らない
			fs.writeFileSync(tmPath, twoConflicts(), "utf-8");
			const prepared = await prepareResolution(collectMdaitConflicts(paths()), config);
			const plan = prepared.summary.plans[0];
			for (const item of plan.pending) {
				rememberDecision(tmPath, stampOf(prepared, tmPath), item.key, "theirs");
			}

			const outcome = await applyDecidedResolution(plan, prepared, config, decisionsFor(tmPath, stampOf(prepared, tmPath)));

			assert.equal(outcome.written, true);
			assert.equal(outcome.remainingCount, 0);
		});
	});
});
