/*
 * `.mdait/translations.tmx`（翻訳メモリ）の合流を測る。
 *
 * `merge.mjs` / `merge-extra.mjs` はここを一度も測っていない。TMX は
 *   - tuid 順に並んだ XML の `<tu>` ブロックの列
 *   - 骨格（区画の目印）も、ブロックとブロックのあいだの空行も無い
 *   - 骨格が無いぶん、両陣営の追加が同じ隙間へ入りやすい
 * なので、2人が同じ日に翻訳メモリへ登録したときにどうなるかは未知だった。
 *
 *   node scripts/lab/scenarios/merge-tmx-probe.mjs
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
import { fileURLToPath } from "node:url";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const { TmxStore } = require(path.join(REPO, "out/core/tm/tmx-store.js"));
const { calculateHash } = require(path.join(REPO, "out/core/hash/hash-calculator.js"));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "tmx-"));
let seq = 0;
function tmxOf(sentences) {
	const dir = path.join(TMP, `d${seq++}`);
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, "translations.tmx");
	TmxStore.dispose?.();
	const store = TmxStore.getInstance(file);
	store.clear?.();
	for (const s of sentences) {
		store.addEntry({
			tuid: calculateHash(s),
			primary: s,
			variants: new Map([
				["en", { text: s }],
				["ja", { text: `${s} の訳` }],
			]),
		});
	}
	store.save(file);
	return fs.readFileSync(file, "utf-8");
}

const merge = (base, mine, theirs, argv) => {
	const f = (n, c) => {
		const p = path.join(TMP, n);
		fs.writeFileSync(p, c);
		return p;
	};
	const a = f("mine", mine);
	const b = f("base", base);
	const c = f("theirs", theirs);
	try {
		const out = execFileSync(argv[0], [...argv.slice(1), a, b, c], { encoding: "utf-8", maxBuffer: 64e6 });
		return { text: out, conflicts: 0 };
	} catch (e) {
		const text = e.stdout ?? "";
		return { text, conflicts: (text.match(/^<{7}/gm) ?? []).length };
	}
};
const ways = {
	git: ["git", "merge-file", "-p", "--diff3"],
	diff3: ["diff3", "-m"],
	union: ["git", "merge-file", "-p", "--union"],
};

function readBack(text) {
	const dir = path.join(TMP, `r${seq++}`);
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, "translations.tmx");
	fs.writeFileSync(file, text);
	TmxStore.dispose?.();
	try {
		const store = TmxStore.getInstance(file);
		return store.size?.() ?? [...(store.index ?? [])].length ?? -1;
	} catch (e) {
		return `読めない(${String(e).slice(0, 40)})`;
	}
}

function trial(seed, baseCount, addCount) {
	let x = seed >>> 0;
	const rand = () => ((x = (x * 1664525 + 1013904223) >>> 0), x / 0x100000000);
	const sent = () => `sentence ${Math.floor(rand() * 1e9)}`;
	const base = new Set();
	while (base.size < baseCount) base.add(sent());
	const mine = new Set(base);
	while (mine.size < baseCount + addCount) mine.add(sent());
	const theirs = new Set(base);
	while (theirs.size < baseCount + addCount) theirs.add(sent());
	const b = tmxOf(base);
	const m = tmxOf(mine);
	const t = tmxOf(theirs);
	const out = {};
	for (const [w, argv] of Object.entries(ways)) {
		const r = merge(b, m, t, argv);
		out[w] = { conflicts: r.conflicts, entries: r.conflicts === 0 ? readBack(r.text) : "-" };
	}
	return { out, want: new Set([...mine, ...theirs]).size };
}

console.log("translations.tmx の合流（union は比較用。製品は `.gitattributes` を置かない — ADR-260911-01）\n");
console.log("  形                              git                diff3              union");
console.log(`  ${"-".repeat(76)}`);
for (const [baseCount, addCount] of [
	[50, 1],
	[200, 5],
	[500, 20],
	[2000, 50],
]) {
	const trials = 20;
	const totals = { git: 0, diff3: 0, union: 0 };
	let sample = null;
	for (let i = 0; i < trials; i++) {
		const r = trial(2000 + i, baseCount, addCount);
		for (const w of Object.keys(totals)) if (r.out[w].conflicts > 0) totals[w]++;
		if (i === 0) sample = r;
	}
	const label = `${baseCount}件へ両側${addCount}件ずつ`;
	console.log(
		`  ${label.padEnd(26)}${["git", "diff3", "union"].map((w) => `競合 ${totals[w]}/${trials}`.padEnd(19)).join("")}`,
	);
	console.log(
		`  ${"".padEnd(26)}${["git", "diff3", "union"]
			.map((w) => `読めた件数 ${sample.out[w].entries}`.padEnd(19))
			.join("")}（あるべき ${sample.want}）`,
	);
}
fs.rmSync(TMP, { recursive: true, force: true });
