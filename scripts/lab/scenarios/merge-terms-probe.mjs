#!/usr/bin/env node
/*
 * 用語集（terms.csv）の合流を測る（調査用・CI 非対象）。
 *
 * 製品の `TermsRepositoryCSV` で用語集を作り、2つの枝でそれぞれ語を足してから合流させる。
 * 読み戻しも製品を通すので、ここに出る消失はそのまま実機で起きる消失である。
 *
 * 既存語は 10 刻みで並べ、足す語はその隙間に入れる。**末尾へ足し合う形にしてはいけない**
 * — それは原稿そのものが競合するのと同じ形で、必ず競合する（測る意味がない）。
 *
 *   node scripts/lab/scenarios/merge-terms-probe.mjs
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
const { TermsRepositoryCSV } = require(path.join(REPO, "out/commands/term/terms-repository-csv.js"));
const { TermEntry } = require(path.join(REPO, "out/commands/term/term-entry.js"));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-terms-"));
const PAIRS = [{ sourceLang: "en", targetLang: "ja", sourceDir: "content/en", targetDir: "content/ja" }];

function word(i) {
	return TermEntry.create(`term${String(i).padStart(4, "0")}`, {
		en: { term: `term${String(i).padStart(4, "0")}`, variants: [] },
		ja: { term: `用語${i}`, variants: [] },
	});
}
async function build(file, count, extra) {
	const repo = await TermsRepositoryCSV.create(file, PAIRS);
	const words = [];
	for (let i = 0; i < count; i++) words.push(word(i * 10)); // 隙間を空けて並べる
	for (const i of extra) words.push(word(i));
	await repo.Merge(words, PAIRS);
	await repo.save();
	return fs.readFileSync(file, "utf-8");
}
function pick(n, count, seed) {
	const out = new Set();
	let x = seed;
	while (out.size < n) {
		x = (x * 1103515245 + 12345) % 2147483648;
		out.add((x % (count * 10 - 2)) + 1); // 既存語（0,10,20,...）の隙間に入る値
	}
	return [...out];
}
function merge(mode, base, mine, theirs) {
	const d = fs.mkdtempSync(path.join(TMP, "m-"));
	const f = (n, c) => { const p = path.join(d, n); fs.writeFileSync(p, c); return p; };
	const [b, m, t] = [f("base", base), f("mine", mine), f("theirs", theirs)];
	const args = mode === "union" ? ["merge-file", "--union", "-p", m, b, t] : ["merge-file", "-p", m, b, t];
	try {
		if (mode === "diff3") {
			const out = execFileSync("diff3", ["-m", m, b, t], { encoding: "utf-8" });
			return { conflict: /^<{7}/m.test(out), text: out };
		}
		const out = execFileSync("git", args, { encoding: "utf-8" });
		return { conflict: false, text: out };
	} catch (e) {
		const out = String(e.stdout ?? "");
		return { conflict: true, text: out };
	}
}
async function readBack(text, label) {
	const p = path.join(TMP, `${label}.csv`);
	fs.writeFileSync(p, text);
	try {
		const repo = await TermsRepositoryCSV.load(p, PAIRS);
		return (await repo.getAllEntries()).length;
	} catch (e) {
		return `読めない（${String(e.message).slice(0, 40)}）`;
	}
}
const TRIALS = 20;
console.log("\nterms.csv の合流\n");
console.log("  形                        git         diff3       union");
for (const [count, add] of [[50, 1], [200, 3], [500, 10]]) {
	const row = { git: 0, diff3: 0, union: 0 };
	let unionCount = null;
	for (let t = 0; t < TRIALS; t++) {
		const file = path.join(TMP, `w${t}`, "terms.csv");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const base = await build(file, count, []);
		const mine = await build(file, count, pick(add, count, t * 7 + 1));
		const theirs = await build(file, count, pick(add, count, t * 13 + 5));
		for (const mode of ["git", "diff3", "union"]) {
			const r = merge(mode, base, mine, theirs);
			if (r.conflict) row[mode]++;
			else if (mode === "union" && unionCount === null) unionCount = await readBack(r.text, `u${count}`);
		}
	}
	console.log(`  ${count}語へ両側${add}語ずつ`.padEnd(26) + `${row.git}/${TRIALS}`.padEnd(12) + `${row.diff3}/${TRIALS}`.padEnd(12) + `${row.union}/${TRIALS}`);
	if (unionCount !== null) console.log(`  ${"".padEnd(24)}union で読めた語数: ${unionCount}（あるべき ${count + add * 2}）`);
}
fs.rmSync(TMP, { recursive: true, force: true });
