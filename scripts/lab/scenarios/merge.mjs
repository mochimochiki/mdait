#!/usr/bin/env node
/*
 * マージ実験場（調査用・CI 非対象）。
 *
 * 何をする道具か
 * --------------
 * `.mdait/unit-state` と `.mdait/unit-registry` を、**別々の枝で編集してから合流させる**。
 * 「別の記事を足した」「同じ記事の別の章を直した」「記事を1本消した」といった、翻訳の
 * 現場でふつうに起きる合流を1つずつ起こし、合流のあとに何が残っているかをそのまま書き出す。
 *
 * 3通りの合流のしかたを同じ手順で流す。
 *   git      … git の素の3方向マージ（`git merge-file`）
 *   diff3    … GNU diff3。**SVN の合流はこちら**。git 固有の指定が効かない世界の代表
 *   union    … `.gitattributes` の `merge=union`（`git merge-file --union` で再現）
 *
 * 出る数字は2つで、**2つ目がこの道具の本体**である。
 *   競合  … 人が手で解く羽目になった箇所の数
 *   消失  … 競合が出なかったのに、**あったはずの状態が消えた**行の数
 *
 * union は競合を出さない代わりに、同じ席（path と order が同じ）の行を後勝ちで潰す。
 * つまり「競合ゼロ」は無事の証しではない。読み込みは**製品と同じ `UnitStateStore` /
 * `UnitRegistryStore`** を通すので、ここに出る消失はそのまま実機で起きる消失である。
 *
 * 使い方
 * ------
 *   node scripts/lab/lab.mjs merge              （まとめ役から呼ばれる形）
 *   node scripts/lab/scenarios/merge.mjs        （単独で動かす）
 *   node scripts/lab/scenarios/merge.mjs --only S2,S12
 *   node scripts/lab/scenarios/merge.mjs --out <出力先>    （前後の比較用に数字を残す）
 *   node scripts/lab/scenarios/merge.mjs --trials 50       （台帳の試行回数）
 *
 * 前提: `npm run compile` 済みであること（out/ の製品コードを読む）。
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const { UnitStateStore } = require(path.join(REPO, "out/core/unit-state/unit-state-store.js"));
const { UnitRegistryStore } = require(path.join(REPO, "out/core/unit-registry/unit-registry-store.js"));
const { calculateHash } = require(path.join(REPO, "out/core/hash/hash-calculator.js"));
const { HELD_ORDER_BASE, FRONT_MATTER_ORDER } = require(
	path.join(REPO, "out/core/unit-state/unit-state-store.js"),
);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-merge-"));

/* ------------------------------------------------------------------ *
 * 世界（原稿の状態）の作り方
 * ------------------------------------------------------------------ */

/** 記事1本 = path と、その中の章の並び。章は「題」で見分ける（順番が変わっても同じ章） */
function article(name, chapterTitles, { translated = false } = {}) {
	return {
		path: `content/en/${name}.md`,
		units: chapterTitles.map((title, i) => ({
			title,
			level: i === 0 ? 1 : 2,
			body: `${title} の本文`,
			from: translated ? calculateHash(`${title} の本文`) : "",
			need: translated ? "" : "translate",
		})),
	};
}

function world(articles) {
	return articles.map((a) => ({ path: a.path, units: a.units.map((u) => ({ ...u })) }));
}

const clone = (w) => world(w);

const findArticle = (w, name) => {
	const found = w.find((a) => a.path === `content/en/${name}.md`);
	if (!found) throw new Error(`記事が見つかりません: ${name}`);
	return found;
};

/* --- 編集の部品（枝の上で起きること） --- */

const addArticle = (name, titles) => (w) => {
	w.push(article(name, titles));
	w.sort((a, b) => a.path.localeCompare(b.path));
	return w;
};

const chapterIndex = (a, title) => {
	const i = a.units.findIndex((u) => u.title === title);
	if (i < 0) throw new Error(`章が見つかりません: ${a.path} / ${title}`);
	return i;
};

/** 章は題で指す。枝の上で順番が変わっても同じ章を指し続けるため（index では追えない） */
const insertChapter = (name, beforeTitle, title) => (w) => {
	const a = findArticle(w, name);
	const at = beforeTitle === null ? a.units.length : chapterIndex(a, beforeTitle);
	a.units.splice(at, 0, { title, level: 2, body: `${title} の本文`, from: "", need: "translate" });
	return w;
};

const editChapter = (name, title) => (w) => {
	const a = findArticle(w, name);
	const unit = a.units[chapterIndex(a, title)];
	unit.body = `${unit.body}（書き手が直した）`;
	unit.need = `revise@${calculateHash(unit.body)}`;
	return w;
};

const translateChapter = (name, title) => (w) => {
	const a = findArticle(w, name);
	const unit = a.units[chapterIndex(a, title)];
	unit.from = calculateHash(unit.body);
	unit.need = "";
	return w;
};

const deleteChapter = (name, title) => (w) => {
	const a = findArticle(w, name);
	a.units.splice(chapterIndex(a, title), 1);
	return w;
};

const deleteArticle = (name) => (w) => w.filter((a) => a.path !== `content/en/${name}.md`);

const renameArticle = (name, to) => (w) => {
	findArticle(w, name).path = `content/en/${to}.md`;
	w.sort((a, b) => a.path.localeCompare(b.path));
	return w;
};

const apply = (w, ...edits) => edits.reduce((acc, edit) => edit(acc) ?? acc, clone(w));

/* ------------------------------------------------------------------ *
 * 製品コードを通した書き出し・読み込み
 * ------------------------------------------------------------------ */

function toEntries(w) {
	const entries = [];
	for (const a of w) {
		a.units.forEach((u, i) => {
			entries.push({
				path: a.path,
				order: i,
				level: u.level,
				titleHash: calculateHash(u.title),
				hash: calculateHash(u.body),
				from: u.from,
				need: u.need,
			});
		});
	}
	return entries;
}

let dirSeq = 0;
function freshMdaitDir() {
	const dir = path.join(TMP, `d${dirSeq++}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

/** 世界を、製品の `save()` が書くのと同じバイト列にする */
function serializeState(w) {
	UnitStateStore.dispose();
	const store = UnitStateStore.getInstance();
	for (const entry of toEntries(w)) store.setEntry(entry);
	const dir = freshMdaitDir();
	store.save(dir);
	UnitStateStore.dispose();
	return fs.readFileSync(path.join(dir, "unit-state"), "utf-8");
}

/** 合流のあとのバイト列を、製品の `load()` が読むとおりに読む */
function loadState(content) {
	const dir = freshMdaitDir();
	fs.writeFileSync(path.join(dir, "unit-state"), content, "utf-8");
	UnitStateStore.dispose();
	const store = UnitStateStore.getInstance();
	store.load(dir);
	const entries = store.getAllEntries();
	UnitStateStore.dispose();
	return entries;
}

/* ------------------------------------------------------------------ *
 * 3通りの合流
 * ------------------------------------------------------------------ */

function writeTriplet(base, mine, theirs) {
	const dir = freshMdaitDir();
	const files = {
		base: path.join(dir, "base"),
		mine: path.join(dir, "mine"),
		theirs: path.join(dir, "theirs"),
	};
	fs.writeFileSync(files.base, base);
	fs.writeFileSync(files.mine, mine);
	fs.writeFileSync(files.theirs, theirs);
	return files;
}

function runMerge(argv, files, { stdoutIsResult }) {
	try {
		const out = execFileSync(argv[0], [...argv.slice(1), files.mine, files.base, files.theirs], {
			encoding: "utf-8",
			maxBuffer: 64 * 1024 * 1024,
		});
		return { text: stdoutIsResult ? out : fs.readFileSync(files.mine, "utf-8"), conflicted: false };
	} catch (error) {
		// 競合があると終了コードが非0になる。出力そのものは合流結果として使える
		if (typeof error.stdout === "string") return { text: error.stdout, conflicted: true };
		throw error;
	}
}

const MERGERS = {
	git: (files) => runMerge(["git", "merge-file", "-p", "--diff3"], files, { stdoutIsResult: true }),
	diff3: (files) => runMerge(["diff3", "-m"], files, { stdoutIsResult: true }),
	union: (files) => runMerge(["git", "merge-file", "-p", "--union"], files, { stdoutIsResult: true }),
};

const countConflicts = (text) => (text.match(/^<{7}/gm) ?? []).length;

/* ------------------------------------------------------------------ *
 * 「あったはずの状態」との突き合わせ
 * ------------------------------------------------------------------ */

/**
 * 章の身元は「path と題」で見る。order は合流で動きうるし、そもそも動いてよい。
 * 見るのは hash（前回の原文）・from（訳の宛先）・need（次にすべきこと）の3つで、
 * この3つが揃って初めて「その章の状態が生きている」と言える。
 */
const identity = (e) => `${e.path}\t${e.titleHash}`;
const meaning = (e) => `${e.hash}\t${e.from}\t${e.need}`;

function compare(expected, actual) {
	const want = new Map();
	for (const e of toEntries(expected)) want.set(identity(e), meaning(e));

	const got = new Map();
	const held = new Map();
	for (const e of actual) {
		const key = identity(e);
		if (!got.has(key)) got.set(key, new Set());
		got.get(key).add(meaning(e));
		if (e.order >= HELD_ORDER_BASE && e.order !== FRONT_MATTER_ORDER) {
			held.set(key, (held.get(key) ?? 0) + 1);
		}
	}

	let lost = 0;
	for (const [key, value] of want) {
		if (!got.get(key)?.has(value)) lost++;
	}
	// 保留席の行は「位置は無いが状態は預かっている」ので、増えた行としては数えない。
	// 次の sync が本文と突き合わせて拾い直すか、拾われなければそのまま静かに残る
	let ghost = 0;
	for (const [key, values] of got) {
		const extra = want.has(key) ? values.size - 1 : values.size;
		ghost += Math.max(0, extra - (held.get(key) ?? 0));
	}
	return { lost, ghost };
}

/* ------------------------------------------------------------------ *
 * 手順（何を合流させるか）
 * ------------------------------------------------------------------ */

const SMALL = world([
	article("a1", ["記事1", "a1第1章", "a1第2章", "a1第3章"], { translated: true }),
	article("a2", ["記事2", "a2第1章", "a2第2章", "a2第3章"], { translated: true }),
	article("a3", ["記事3", "a3第1章", "a3第2章", "a3第3章"], { translated: true }),
	article("a4", ["記事4", "a4第1章", "a4第2章", "a4第3章"], { translated: true }),
	article("a5", ["記事5", "a5第1章", "a5第2章", "a5第3章"], { translated: true }),
]);

/** 非MDファイル（.txt / .csv）は「ファイル＝1ユニット」の1行ブロックになる */
function flatFile(name) {
	return {
		path: `content/en/${name}.txt`,
		units: [{ title: "", level: 0, body: `${name} の中身`, from: calculateHash(`${name} の中身`), need: "" }],
	};
}

const FLAT = world(Array.from({ length: 12 }, (_, i) => flatFile(`t${String(i + 1).padStart(2, "0")}`)));

const addFlat = (name) => (w) => {
	w.push(flatFile(name));
	w.sort((a, b) => a.path.localeCompare(b.path));
	return w;
};

const deleteFlat = (name) => (w) => w.filter((a) => a.path !== `content/en/${name}.txt`);

const editFlat = (name) => (w) => {
	const a = w.find((x) => x.path === `content/en/${name}.txt`);
	if (!a) throw new Error(`ファイルが見つかりません: ${name}`);
	a.units[0].body = `${a.units[0].body}（直した）`;
	a.units[0].need = `revise@${calculateHash(a.units[0].body)}`;
	return w;
};

const BIG = world(
	Array.from({ length: 20 }, (_, i) =>
		article(`b${String(i + 1).padStart(2, "0")}`, [`b${i}導入`, `b${i}第1章`, `b${i}第2章`, `b${i}第3章`, `b${i}第4章`], {
			translated: true,
		}),
	),
);

const SCENARIOS = [
	{ id: "S1", name: "別々の新しい記事を1本ずつ追加", base: SMALL, a: [addArticle("n1", ["新1", "新1章"])], b: [addArticle("n2", ["新2", "新2章"])] },
	{ id: "S2", name: "同じ記事に章を挿入／別の章を改訂", base: SMALL, a: [insertChapter("a2", "a2第1章", "割り込み章")], b: [editChapter("a2", "a2第3章")] },
	{ id: "S3", name: "記事a3へ章を挿入／記事a5を改訂", base: SMALL, a: [insertChapter("a3", "a3第2章", "割り込み章")], b: [editChapter("a5", "a5第2章")] },
	{ id: "S4", name: "別々の記事を翻訳（need 列だけ動く）", base: SMALL, a: [translateChapter("a1", "a1第1章")], b: [translateChapter("a4", "a4第1章")] },
	{ id: "S5", name: "同じ記事の離れた章をそれぞれ改訂", base: SMALL, a: [editChapter("a3", "記事3")], b: [editChapter("a3", "a3第3章")] },
	{ id: "S6", name: "同じ記事の隣り合う章をそれぞれ改訂", base: SMALL, a: [editChapter("a3", "a3第1章")], b: [editChapter("a3", "a3第2章")] },
	{ id: "S7", name: "隣り合う記事をそれぞれ改訂", base: SMALL, a: [editChapter("a2", "a2第3章")], b: [editChapter("a3", "記事3")] },
	{ id: "S8", name: "記事を追加／既存の記事へ章を挿入", base: SMALL, a: [addArticle("n1", ["新1", "新1章"])], b: [insertChapter("a4", "a4第1章", "割り込み章")] },
	{ id: "S9", name: "同じ記事に両方が別々の章を挿入", base: SMALL, a: [insertChapter("a3", "a3第1章", "割り込みA")], b: [insertChapter("a3", "a3第3章", "割り込みB")] },
	{ id: "S10", name: "記事a3の先頭章を削除／同じ記事の末尾章を改訂", base: SMALL, a: [deleteChapter("a3", "a3第1章")], b: [editChapter("a3", "a3第3章")] },
	{ id: "S11", name: "20記事: 片方が3本追加／片方が2本追加", base: BIG, a: [addArticle("c1", ["新1", "新1章"]), addArticle("c2", ["新2", "新2章"]), addArticle("c3", ["新3", "新3章"])], b: [addArticle("d1", ["新4", "新4章"]), addArticle("d2", ["新5", "新5章"])] },
	{ id: "S12", name: "記事を1本削除／別の記事を翻訳", base: SMALL, a: [deleteArticle("a1")], b: [translateChapter("a2", "a2第1章")] },
	{ id: "S13", name: "同じ章を両方が別々に改訂（本物の競合）", base: SMALL, a: [editChapter("a3", "a3第2章")], b: [translateChapter("a3", "a3第2章")], expectConflict: true },
	{ id: "S14", name: "同じ記事の末尾に両方が章を追記（本物の競合）", base: SMALL, a: [insertChapter("a3", null, "末尾A")], b: [insertChapter("a3", null, "末尾B")], expectConflict: true },
	{ id: "S15", name: "記事を改名／別の記事を改訂", base: SMALL, a: [renameArticle("a2", "a2-renamed")], b: [editChapter("a4", "a4第2章")] },
	{ id: "S17", name: "1行ブロック: 1本削除／隣を改訂", base: FLAT, a: [deleteFlat("t05")], b: [editFlat("t06")] },
	{ id: "S18", name: "1行ブロック: 両方が別々に1本ずつ追加", base: FLAT, a: [addFlat("t05a")], b: [addFlat("t05b")] },
	{ id: "S19", name: "1行ブロック: 離れた2本をそれぞれ改訂", base: FLAT, a: [editFlat("t02")], b: [editFlat("t09")] },
	{ id: "S20", name: "1行ブロック: 隣り合う2本をそれぞれ改訂", base: FLAT, a: [editFlat("t05")], b: [editFlat("t06")] },
	{ id: "S16", name: "20記事: 両方が8本ずつ追加（重い日）", base: BIG, a: Array.from({ length: 8 }, (_, i) => addArticle(`e${i}`, [`新e${i}`, `新e${i}章`])), b: Array.from({ length: 8 }, (_, i) => addArticle(`f${i}`, [`新f${i}`, `新f${i}章`])) },
];

function runScenario(scenario) {
	const base = scenario.base;
	const mine = apply(base, ...scenario.a);
	const theirs = apply(base, ...scenario.b);
	const expected = apply(mine, ...scenario.b);

  const files = writeTriplet(serializeState(base), serializeState(mine), serializeState(theirs));
	const result = { id: scenario.id, name: scenario.name, expectConflict: !!scenario.expectConflict, ways: {} };
	for (const [way, merger] of Object.entries(MERGERS)) {
		const merged = merger(files);
		const conflicts = countConflicts(merged.text);
		const { lost, ghost } = compare(expected, loadState(merged.text));
		result.ways[way] = { conflicts, lost, ghost };
	}
	return result;
}

/* ------------------------------------------------------------------ *
 * 台帳（unit-registry）の合流
 * ------------------------------------------------------------------ */

/** 決まった種から同じ並びを返す乱数（試行を再現できるようにする） */
function seeded(seed) {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 0x100000000;
	};
}

function registrySerialize(hashes) {
	const store = new UnitRegistryStore();
	for (const h of hashes) store.upsert(h, "eJxLyU");
	return `${store.serialize()}\n`;
}

function registryTrial(seed, baseCount, addCount) {
	const rand = seeded(seed);
	const hex = () =>
		Array.from({ length: 8 }, () => "0123456789abcdef"[Math.floor(rand() * 16)]).join("");
	const base = new Set();
	while (base.size < baseCount) base.add(hex());
	const mine = new Set(base);
	while (mine.size < baseCount + addCount) mine.add(hex());
	const theirs = new Set(base);
	while (theirs.size < baseCount + addCount) theirs.add(hex());

	const files = writeTriplet(
		registrySerialize(base),
		registrySerialize(mine),
		registrySerialize(theirs),
	);
	const out = {};
	for (const [way, merger] of Object.entries(MERGERS)) {
		const merged = merger(files);
		const conflicts = countConflicts(merged.text);
		const store = new UnitRegistryStore();
		store.parse(merged.text);
		const want = new Set([...mine, ...theirs]);
		let lost = 0;
		for (const h of want) if (store.get(h) === null) lost++;
		out[way] = { conflicts, lost };
	}
	return out;
}

function runRegistry(trials, { baseCount = 2000, addCount = 30 } = {}) {
	const totals = { git: { conflicted: 0, lost: 0 }, diff3: { conflicted: 0, lost: 0 }, union: { conflicted: 0, lost: 0 } };
	for (let i = 0; i < trials; i++) {
		const result = registryTrial(1000 + i, baseCount, addCount);
		for (const way of Object.keys(totals)) {
			if (result[way].conflicts > 0) totals[way].conflicted++;
			totals[way].lost += result[way].lost;
		}
	}
	const bytes = registrySerialize(new Set(Array.from({ length: baseCount }, (_, i) => calculateHash(`u${i}`)))).length;
	return { trials, baseCount, addCount, totals, bytes };
}

/* ------------------------------------------------------------------ *
 * 出力
 * ------------------------------------------------------------------ */

function pad(text, width) {
	const w = [...text].reduce((n, c) => n + (/[^\x00-\x7F]/.test(c) ? 2 : 1), 0);
	return text + " ".repeat(Math.max(0, width - w));
}

function report(results, registry) {
	console.log("\n合流のあとに何が残るか（競合 / 消失 / 増殖）");
	console.log("  競合 = 人が手で解く箇所の数、消失 = あったはずの状態が消えた行、増殖 = 余計に生えた行\n");
	console.log(`  ${pad("", 4)}${pad("手順", 44)}${pad("git", 16)}${pad("diff3(SVN)", 16)}${pad("union", 16)}`);
	console.log(`  ${"-".repeat(96)}`);
	for (const r of results) {
		const cell = (w) => `${r.ways[w].conflicts} / ${r.ways[w].lost} / ${r.ways[w].ghost}`;
		const mark = r.expectConflict ? "*" : " ";
		console.log(
			`  ${pad(`${r.id}${mark}`, 4)}${pad(r.name, 44)}${pad(cell("git"), 16)}${pad(cell("diff3"), 16)}${pad(cell("union"), 16)}`,
		);
	}
	console.log("\n  * は「原稿そのものが競合する手順」。ここで競合が出るのは正しい。");

	const sum = (way, key) =>
		results.filter((r) => !r.expectConflict).reduce((n, r) => n + r.ways[way][key], 0);
	console.log("\n  合計（* を除く。どちらもゼロが目標）");
	for (const way of ["git", "diff3", "union"]) {
		console.log(`    ${pad(way, 12)}競合 ${sum(way, "conflicts")}　消失 ${sum(way, "lost")}　増殖 ${sum(way, "ghost")}`);
	}

	if (registry) {
		console.log(
			`\n台帳（unit-registry）: ${registry.baseCount} 件の台帳へ、両方の枝が ${registry.addCount} 件ずつ足す。${registry.trials} 回`,
		);
		for (const way of ["git", "diff3", "union"]) {
			const t = registry.totals[way];
			console.log(
				`    ${pad(way, 12)}競合した回 ${pad(`${t.conflicted}/${registry.trials}`, 10)}消失 ${t.lost} 件`,
			);
		}
		console.log(`    骨格込みの寸法: ${(registry.bytes / 1024).toFixed(0)} KB`);
	}
}

/* ------------------------------------------------------------------ */

export function run({ only, trials = 30, out } = {}) {
	const wanted = only ? new Set(String(only).split(",").map((s) => s.trim())) : undefined;
	const results = SCENARIOS.filter((s) => !wanted || wanted.has(s.id)).map(runScenario);
	const registry = wanted ? undefined : runRegistry(trials);
	report(results, registry);
	if (typeof out === "string" && out) {
		fs.writeFileSync(out, `${JSON.stringify({ results, registry }, null, 2)}\n`, "utf-8");
		console.log(`\n数字を書き出しました: ${out}`);
	}
	fs.rmSync(TMP, { recursive: true, force: true });
	return { results, registry };
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const args = process.argv.slice(2);
	const opt = (name) => {
		const i = args.indexOf(`--${name}`);
		return i >= 0 ? args[i + 1] : undefined;
	};
	run({ only: opt("only"), trials: Number(opt("trials") ?? 30), out: opt("out") });
}
