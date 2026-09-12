#!/usr/bin/env node
/*
 * 合流 → 競合の解決 → 消失を数える、通しの実測台（roadmap-v04 P04。調査用・CI 非対象）。
 *
 * これまでの台（merge.mjs / merge-tmx-probe.mjs / merge-terms-probe.mjs）は「合流したあと
 * 何が残るか」までしか見ていない。**解決を通したあとに何が残るか**は誰も測っていなかった。
 * union をやめた以上、そこを測らないと「直った」と言えない。
 *
 * 製品のコードをそのまま通す。合流は `git merge-file`（git の既定）と GNU diff3（SVN 相当）、
 * 解決は `planTmResolution` / `planTermsResolution` と書き戻しの入口である。
 *
 *   node scripts/lab/scenarios/merge-resolve-probe.mjs
 *
 * 数えるのは3つ。
 *   - **消失** … 合流の前にどちらかの枝にあったのに、解決のあとに無いもの
 *   - **判断待ち** … 人か AI が決めるしかなかった件（少ないほどよい）
 *   - **増殖** … どちらの枝にも無かったのに生えたもの
 *
 * 前提: `npm run compile` 済みであること（out/ の製品コードを読む）。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const { TmxStore } = require(path.join(REPO, "out/core/tm/tmx-store.js"));
const { calculateHash } = require(path.join(REPO, "out/core/hash/hash-calculator.js"));
const { TermsRepositoryCSV } = require(path.join(REPO, "out/commands/term/terms-repository-csv.js"));
const { TermEntry } = require(path.join(REPO, "out/commands/term/term-entry.js"));
const { planTmResolution, applyTmResolution } = require(
	path.join(REPO, "out/commands/conflict/targets/tm-target.js"),
);
const { planTermsResolution, applyTermsResolution } = require(
	path.join(REPO, "out/commands/conflict/targets/terms-target.js"),
);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-resolve-"));
const PAIRS = [{ sourceLang: "en", targetLang: "ja", sourceDir: "content/en", targetDir: "content/ja" }];

/** 合流のしかた。union はもう製品では使わないが、比べるために残す */
const WAYS = {
	git: (files) => run(["git", "merge-file", "-p"], files),
	diff3: (files) => run(["diff3", "-m"], files),
	"git-diff3": (files) => run(["git", "merge-file", "-p", "--diff3"], files),
};

function run(cmd, [mine, base, theirs]) {
	try {
		return execFileSync(cmd[0], [...cmd.slice(1), mine, base, theirs], { encoding: "utf-8" });
	} catch (error) {
		// 競合があると終了コードが 0 以外になる。出力そのものは欲しい
		return error.stdout ?? "";
	}
}

function write(name, content) {
	const file = path.join(TMP, name);
	fs.writeFileSync(file, content, "utf-8");
	return file;
}

// --- 翻訳メモリ -----------------------------------------------------------

function tuid(primary) {
	return calculateHash(primary, true);
}

function tmxOf(entries) {
	const tus = entries.map(
		([primary, ja]) =>
			`<tu tuid="${tuid(primary)}"><tuv xml:lang="en"><seg>${primary}</seg></tuv><tuv xml:lang="ja"><seg>${ja}</seg></tuv></tu>`,
	);
	return `<?xml version="1.0" encoding="UTF-8"?>\n<tmx version="1.4">\n<body>\n${tus.join("\n")}\n</body>\n</tmx>\n`;
}

/** 種から決まる擬似乱数（同じ台が毎回同じ数字を出すように） */
function picker(seed) {
	let x = seed;
	return (limit) => {
		x = (x * 1103515245 + 12345) % 2147483648;
		return x % limit;
	};
}

/**
 * 既存 N 件へ、両方の枝がそれぞれ `add` 件ずつ足す（隙間へ入れる）。
 *
 * `disagree` を立てると、**既存の1件の訳を両方が別々に直す** — 鍵の突き合わせでは
 * 決まらない、人か AI にしか決められない形である。
 */
function tmCase(baseCount, add, next, disagree) {
	const common = [];
	for (let i = 0; i < baseCount; i++) common.push([`sentence ${i * 10}`, `文 ${i * 10}`]);
	const mine = [...common];
	const theirs = [...common];
	for (let i = 0; i < add; i++) {
		const slot = next(baseCount * 10 - 2) + 1;
		mine.push([`sentence ${slot}`, `私の文 ${i}`]);
		theirs.push([`sentence ${slot + 0.5}`, `相手の文 ${i}`]);
	}
	if (disagree) {
		mine[0] = [common[0][0], "私が直した訳"];
		theirs[0] = [common[0][0], "相手が直した訳"];
	}
	const sort = (rows) => [...rows].sort((a, b) => (tuid(a[0]) < tuid(b[0]) ? -1 : 1));
	return { base: sort(common), mine: sort(mine), theirs: sort(theirs) };
}

async function measureTm(way, baseCount, add, next, disagree = false) {
	TmxStore.resetInstance();
	const { base, mine, theirs } = tmCase(baseCount, add, next, disagree);
	const merged = WAYS[way]([write("tm-mine.tmx", tmxOf(mine)), write("tm-base.tmx", tmxOf(base)), write("tm-theirs.tmx", tmxOf(theirs))]);
	const target = write("tm-merged.tmx", merged);

	const wanted = new Set([...mine, ...theirs].map(([primary]) => tuid(primary)));
	const planned = planTmResolution(target);
	if (!planned) {
		// 競合しなかった。そのまま読めるはず
		const got = TmxStore.parseSide(fs.readFileSync(target, "utf-8"));
		return { conflicted: false, pending: 0, lost: countLost(wanted, got), grown: countGrown(wanted, got) };
	}
	// **判断待ちは残したまま**書き戻しを試す（人も AI も居ない前提で、決定的な分だけを見る）
	applyTmResolution(target, planned.plan, planned.resolution, new Map());
	const after = fs.readFileSync(target, "utf-8");
	const got = /^<{7}|^={7}|^>{7}/m.test(after) ? new Map() : TmxStore.parseSide(after);
	return {
		conflicted: true,
		pending: planned.plan.pending.length,
		lost: planned.plan.pending.length > 0 ? 0 : countLost(wanted, got),
		grown: planned.plan.pending.length > 0 ? 0 : countGrown(wanted, got),
		unwritten: planned.plan.pending.length > 0,
	};
}

const countLost = (wanted, got) => [...wanted].filter((key) => !got.has(key)).length;
const countGrown = (wanted, got) => [...got.keys()].filter((key) => !wanted.has(key)).length;

// --- 用語集 ---------------------------------------------------------------

function term(i, ja) {
	const en = `term${String(i).padStart(4, "0")}`;
	return TermEntry.create("", { en: { term: en, variants: [] }, ja: { term: ja ?? `用語${i}`, variants: [] } });
}

async function termsCsv(name, entries) {
	const file = path.join(TMP, name);
	fs.rmSync(file, { force: true });
	const repo = await TermsRepositoryCSV.create(file, PAIRS);
	await repo.Merge(entries, PAIRS);
	await repo.save();
	return fs.readFileSync(file, "utf-8");
}

async function measureTerms(way, baseCount, add, next) {
	const common = [];
	for (let i = 0; i < baseCount; i++) common.push(term(i * 10));
	const mine = [...common];
	const theirs = [...common];
	for (let i = 0; i < add; i++) {
		// 既存語（0,10,20,...）の隙間へ入れる。末尾へ足し合う形は原稿の競合と同じで測る意味がない。
		//
		// **隙間の番号が既存語に当たることがある。** そのとき「片方だけが既存の語を直した」形に
		// なり、これが git と diff3 の差を生む — 祖先があれば「直したほうを採る」と決定的に
		// 決まるが、祖先が無いと「同じ語に別の訳語」としか見えず、人に回る（実測で確かめた）。
		const slot = next(baseCount * 10 - 3) + 1;
		mine.push(term(slot, `私の用語 ${i}`));
		theirs.push(term(slot + 1, `相手の用語 ${i}`));
	}
	const merged = WAYS[way]([
		write("terms-mine.csv", await termsCsv("build-mine.csv", mine)),
		write("terms-base.csv", await termsCsv("build-base.csv", common)),
		write("terms-theirs.csv", await termsCsv("build-theirs.csv", theirs)),
	]);
	const target = write("terms-merged.csv", merged);

	const key = (entry) => TermEntry.getTerm(entry, "en") ?? "";
	const wanted = new Set([...mine, ...theirs].map(key));

	const repo = await TermsRepositoryCSV.create(target, PAIRS);
	const planned = await planTermsResolution(target, repo, "en");
	if (!planned) {
		const back = await TermsRepositoryCSV.load(target);
		const got = new Set([...(await back.getAllEntries())].map(key));
		return { conflicted: false, pending: 0, lost: [...wanted].filter((k) => !got.has(k)).length, grown: [...got].filter((k) => !wanted.has(k)).length };
	}
	await applyTermsResolution(planned.plan, planned.resolution, repo, new Map());
	const after = fs.readFileSync(target, "utf-8");
	if (planned.plan.pending.length > 0 || /^<{7}|^={7}|^>{7}/m.test(after)) {
		return { conflicted: true, pending: planned.plan.pending.length, lost: 0, grown: 0, unwritten: true };
	}
	const back = await TermsRepositoryCSV.load(target);
	const got = new Set([...(await back.getAllEntries())].map(key));
	return {
		conflicted: true,
		pending: 0,
		lost: [...wanted].filter((k) => !got.has(k)).length,
		grown: [...got].filter((k) => !wanted.has(k)).length,
	};
}

// --- 出力 -----------------------------------------------------------------

const pad = (text, width) => String(text).padEnd(width, " ");

/** 同じ形を何度も試して、まとめる */
async function trials(times, measure) {
	const total = { conflicted: 0, pending: 0, lost: 0, grown: 0, unwritten: 0 };
	for (let i = 0; i < times; i++) {
		const found = await measure(picker(i * 7919 + 13));
		if (found.conflicted) total.conflicted++;
		if (found.unwritten) total.unwritten++;
		total.pending += found.pending;
		total.lost += found.lost;
		total.grown += found.grown;
	}
	return total;
}

function cell(total, times) {
	return `競合 ${total.conflicted}/${times}　判断待ち ${total.pending}　消失 ${total.lost}　増殖 ${total.grown}`;
}

const TIMES = 20;

async function main() {
	console.log("合流 → 競合の解決 → 何が残るか（roadmap-v04 P04）\n");
	console.log("  解決は**人も AI も居ない前提**。鍵の突き合わせで決まる分だけで、どこまで片付くかを見る。");
	console.log("  判断待ちが残った対象は1バイトも書かないので、その回の消失・増殖は 0 と数える。\n");

	console.log("翻訳メモリ（translations.tmx）— 両方が別々の文を登録しただけ");
	console.log(`  ${pad("形", 22)}${pad("git", 42)}${pad("diff3(SVN)", 42)}${pad("git --diff3", 42)}`);
	console.log(`  ${"-".repeat(148)}`);
	for (const [baseCount, add] of [
		[50, 1],
		[200, 5],
		[500, 20],
		[2000, 50],
	]) {
		const cells = [];
		for (const way of ["git", "diff3", "git-diff3"]) {
			const total = await trials(TIMES, (next) => measureTm(way, baseCount, add, next));
			cells.push(pad(cell(total, TIMES), 42));
		}
		console.log(`  ${pad(`${baseCount}件へ両側${add}件ずつ`, 22)}${cells.join("")}`);
	}

	console.log("\n翻訳メモリ — **既存の1件の訳を両方が別々に直した**（人か AI にしか決められない形）");
	console.log(`  ${pad("形", 22)}${pad("git", 42)}${pad("diff3(SVN)", 42)}${pad("git --diff3", 42)}`);
	console.log(`  ${"-".repeat(148)}`);
	for (const [baseCount, add] of [
		[200, 5],
		[500, 20],
	]) {
		const cells = [];
		for (const way of ["git", "diff3", "git-diff3"]) {
			const total = await trials(TIMES, (next) => measureTm(way, baseCount, add, next, true));
			cells.push(pad(cell(total, TIMES), 42));
		}
		console.log(`  ${pad(`${baseCount}件へ両側${add}件ずつ`, 22)}${cells.join("")}`);
	}

	console.log("\n用語集（terms.csv）— 両方が別々の語を足しただけ");
	console.log(`  ${pad("形", 22)}${pad("git", 42)}${pad("diff3(SVN)", 42)}${pad("git --diff3", 42)}`);
	console.log(`  ${"-".repeat(148)}`);
	for (const [baseCount, add] of [
		[50, 1],
		[200, 3],
		[500, 10],
	]) {
		const cells = [];
		for (const way of ["git", "diff3", "git-diff3"]) {
			const total = await trials(TIMES, (next) => measureTerms(way, baseCount, add, next));
			cells.push(pad(cell(total, TIMES), 42));
		}
		console.log(`  ${pad(`${baseCount}語へ両側${add}語ずつ`, 22)}${cells.join("")}`);
	}

	console.log("\n  読み方: **消失 0・増殖 0 が絶対の条件**。判断待ちは「人か AI が決めるまで書かない」状態で、");
	console.log("  そのファイルは競合マーカーの入ったまま残る（半端に書き戻して片側を失うことはない）。");
	fs.rmSync(TMP, { recursive: true, force: true });
}

main().catch((error) => {
	console.error(error);
	fs.rmSync(TMP, { recursive: true, force: true });
	process.exit(1);
});
