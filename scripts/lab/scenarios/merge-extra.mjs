#!/usr/bin/env node
/*
 * 合流の実験台・拡張版（調査用・CI 非対象 / 2026-09-07 追加）。
 *
 * `merge.mjs` は `.mdait/unit-state` と `.mdait/unit-registry` **だけ**を合流させる台である。
 * 原稿の Markdown そのものは1バイトも合流させていないので、
 *   - embedded（マーカーが原稿の中にある）との差
 *   - frontmatter 行・保留席・verify-deletion・リネーム追随・章の分割
 * が測れない。この台はその穴を埋める。
 *
 * 測るもの
 * --------
 *   競合  … 人が手で解く箇所の数（**原稿の .md も含めて数える**）
 *   消失  … 競合が出なかったのに、あったはずの状態が消えた行の数
 *   増殖  … 余計に生えた行の数
 *
 * モード
 * ------
 *   external … 状態は `.mdait/unit-state` にある。原稿の .md は本文だけ
 *   embedded … 状態は原稿の .md のマーカー行にある。`unit-state` は非MDファイルの分だけ
 *
 * 使い方
 * ------
 *   node scripts/lab/scenarios/merge-extra.mjs
 *   node scripts/lab/scenarios/merge-extra.mjs --only X3,X7
 *   node scripts/lab/scenarios/merge-extra.mjs --dump X7 --dumpdir /tmp/mdait-agentA/dump
 *   node scripts/lab/scenarios/merge-extra.mjs --out /tmp/mdait-agentA/extra.json
 *
 * 前提: `npm run compile` 済みであること。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import {
	TMP,
	findArticle,
	freshMdaitDir,
	addArticle,
	insertChapter,
	editChapter,
	translateChapter,
	deleteChapter,
	deleteArticle,
	world,
	SMALL,
	BIG,
	FLAT,
	editFlat,
	deleteFlat,
	writeTriplet,
	MERGERS,
	countConflicts,
	pad,
} from "./merge.mjs";

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const { UnitStateStore } = require(path.join(REPO, "out/core/unit-state/unit-state-store.js"));
const { calculateHash } = require(path.join(REPO, "out/core/hash/hash-calculator.js"));
const { ExternalMarkerProvider } = require(path.join(REPO, "out/core/markdown/marker-provider.js"));
const { MdaitMarker } = require(path.join(REPO, "out/core/markdown/mdait-marker.js"));
const { MdaitUnit } = require(path.join(REPO, "out/core/markdown/mdait-unit.js"));

/* ------------------------------------------------------------------ *
 * 追加の編集の部品
 * ------------------------------------------------------------------ */

const chapterOf = (a, title) => {
	const u = a.units.find((x) => x.title === title);
	if (!u) throw new Error(`章が見つかりません: ${a.path} / ${title}`);
	return u;
};

/**
 * **原文だけ**が変わった（sync が走ったところまで）。
 * 訳文の本文（hash）は動かず、`need` に `revise@<新しい原文の hash>` が入る。
 */
export const syncSourceEdit = (name, title) => (w) => {
	const u = chapterOf(findArticle(w, name), title);
	u.need = `revise@${calculateHash(`${u.body}／原文が動いた`)}`;
	return w;
};

/** **訳文だけ**を人が手で直した。`hash` が動き、`from` / `need` は動かない */
export const editTargetOnly = (name, title) => (w) => {
	const u = chapterOf(findArticle(w, name), title);
	u.body = `${u.body}（訳者が手で直した）`;
	return w;
};

/** 章を2つに割る（前半は改訂、後半は新しい未訳の章） */
export const splitChapter = (name, title, newTitle) => (w) => {
	const a = findArticle(w, name);
	const i = a.units.findIndex((x) => x.title === title);
	const u = a.units[i];
	u.body = `${u.body}（前半だけ残した）`;
	u.need = `revise@${calculateHash(u.body)}`;
	a.units.splice(i + 1, 0, {
		title: newTitle,
		level: 2,
		body: `${newTitle} の本文`,
		from: "",
		need: "translate",
	});
	return w;
};

/**
 * まだ訳していない状態に戻す。
 *
 * `merge.mjs` の `SMALL` / `BIG` は**全章が翻訳済み**なので、そこへ `translateChapter` を
 * かけても `from` も `need` も既にその値であり、**枝が base と1バイトも変わらない**
 * （実測で確認）。翻訳を測りたい手順は、まずこれで未訳に戻してから使う。
 */
export const untranslate = (name, title) => (w) => {
	const u = chapterOf(findArticle(w, name), title);
	u.from = "";
	u.need = "translate";
	return w;
};

/** 実際に trans が走った（訳文の本文が入れ替わり、`from` が付き `need` が消える） */
export const transChapter = (name, title) => (w) => {
	const u = chapterOf(findArticle(w, name), title);
	u.from = calculateHash(u.body);
	u.body = `${title} の訳文`;
	u.need = "";
	return w;
};

/** verify-deletion（訳文から章が消えたので、消してよいか人に尋ねている状態） */
export const verifyDeletion = (name, title) => (w) => {
	chapterOf(findArticle(w, name), title).need = "verify-deletion";
	return w;
};

/** frontmatter を触る（`kind: front` の行が動く） */
export const editFront = (name) => (w) => {
	const a = findArticle(w, name);
	a.front = {
		hash: calculateHash(`${a.path} front v2`),
		from: calculateHash(`${a.path} src front v2`),
		need: "revise@ff00ff00",
	};
	return w;
};

export const translateFront = (name) => (w) => {
	const a = findArticle(w, name);
	a.front = { hash: calculateHash(`${a.path} front 訳した`), from: a.front?.from ?? "", need: "" };
	return w;
};

/** リネームを**製品と同じ道**（`movePath`）で追随させる */
export const renameFollow = (name, to) => (w) => {
	const a = findArticle(w, name);
	const from = a.path;
	a.path = `content/en/${to}.md`;
	w.moves = [...(w.moves ?? []), [from, a.path]];
	w.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
	return w;
};

/** フォルダごと動かす（追随あり） */
export const moveAllToSub = () => (w) => {
	const moves = [...(w.moves ?? [])];
	for (const a of w) {
		const from = a.path;
		a.path = a.path.replace("content/en/", "content/en/sub/");
		moves.push([from, a.path]);
	}
	w.moves = moves;
	return w;
};

/**
 * 世界の複製。**`merge.mjs` の `clone` は `path` と `units` しか写さない**ので、
 * frontmatter を持つ世界をそのまま通すと枝の途中で front が消える（実測で気づいた）。
 */
const clone2 = (w) =>
	w.map((a) => ({ path: a.path, units: a.units.map((u) => ({ ...u })), ...(a.front ? { front: { ...a.front } } : {}) }));

/** `apply` の front を落とさない版 */
const apply2 = (w, ...edits) => edits.reduce((acc, edit) => edit(acc) ?? acc, clone2(w));

/** 記事に frontmatter を持たせた版を作る */
function withFront(a) {
	return {
		...a,
		front: {
			hash: calculateHash(`${a.path} front`),
			from: calculateHash(`${a.path} src front`),
			need: "",
		},
	};
}

/* ------------------------------------------------------------------ *
 * 世界 → ディスク上のファイル一式
 * ------------------------------------------------------------------ */

/** 世界を `.mdait/unit-state` のバイト列にする（front / movePath に対応した版） */
function stateOf2(w, prior) {
	const dir = freshMdaitDir();
	const filePath = path.join(dir, "unit-state");
	if (prior) fs.writeFileSync(filePath, prior, "utf-8");

	UnitStateStore.dispose();
	const store = UnitStateStore.getInstance();
	store.load(dir);
	const provider = new ExternalMarkerProvider(store);

	// リネーム追随（`relocateUnitEntries` が通る道）
	for (const [from, to] of w.moves ?? []) {
		store.movePath(from, to);
	}

	const alive = new Set(w.map((a) => a.path));
	for (const entry of store.getAllEntries()) {
		if (!alive.has(entry.path)) store.removeEntriesByPath(entry.path);
	}

	for (const a of w) {
		const units = a.units.map(
			(u) =>
				new MdaitUnit(new MdaitMarker(calculateHash(u.body), null, null), u.title, u.level, u.body, 0, 0),
		);
		const ctx = { filePath: a.path, role: "target" };
		provider.attachMarkers(units, ctx);
		units.forEach((unit, i) => {
			const u = a.units[i];
			unit.marker = new MdaitMarker(calculateHash(u.body), u.from || null, u.need || null);
		});
		provider.detachMarkers(units, ctx);
		if (a.front) {
			store.setFrontMatterEntry(a.path, a.front);
		}
	}

	store.save(dir);
	UnitStateStore.dispose();
	return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : (prior ?? "");
}

function loadState2(content) {
	const dir = freshMdaitDir();
	fs.writeFileSync(path.join(dir, "unit-state"), content, "utf-8");
	UnitStateStore.dispose();
	const store = UnitStateStore.getInstance();
	store.load(dir);
	const entries = store.getAllEntries();
	UnitStateStore.dispose();
	return entries;
}

const isMd = (p) => p.endsWith(".md");

/** ユニット1つ分の本文（見出し＋空行＋本文）。非MD（level 0）は本文だけ */
const unitBody = (u) => (u.level === 0 ? u.body : `${"#".repeat(u.level)} ${u.title}\n\n${u.body}`);

/**
 * 世界を、**そのモードでディスクに置かれるファイル一式**にする。
 *
 * - external: `.md` は本文だけ。状態は `.mdait/unit-state` に集まる
 * - embedded: `.md` にマーカー行が入る。frontmatter マーカーも frontmatter に入る。
 *   ただし**非MD（.txt）は embedded でも `unit-state` に入る**（`plain-file-handler` に
 *   モードの分岐が無い。ソースを読んで確認済み）
 */
function filesOf(w, mode, prior) {
	const files = {};
	for (const a of w) {
		if (!isMd(a.path)) {
			continue;
		}
		const parts = a.units.map((u) => {
			const body = unitBody(u);
			if (mode === "embedded") {
				const m = new MdaitMarker(calculateHash(u.body), u.from || null, u.need || null);
				return `${m.toString()}\n${body}`;
			}
			return body;
		});
		let head = "";
		if (a.front) {
			const lines = ["---", `title: ${a.path}`];
			if (mode === "embedded") {
				const m = new MdaitMarker(a.front.hash, a.front.from || null, a.front.need || null);
				lines.push(`mdait: '${m.toString().replace(/^<!-- mdait ?/, "").replace(/ ?-->$/, "")}'`);
			}
			lines.push("---", "");
			head = `${lines.join("\n")}\n`;
		}
		files[a.path] = `${head}${parts.join("\n\n")}\n`;
	}
	// unit-state。embedded では非MDファイルの行だけが載る
	const forState =
		mode === "embedded"
			? Object.assign(
					w.filter((a) => !isMd(a.path)).map((a) => ({ ...a })),
					{ moves: w.moves },
				)
			: w;
	const state = stateOf2(forState, prior ?? "");
	if (state.trim()) {
		files[".mdait/unit-state"] = state;
	}
	return files;
}

/* ------------------------------------------------------------------ *
 * ファイル一式の3方向合流
 * ------------------------------------------------------------------ */

/**
 * 3つのファイル一式を合流させる。
 *
 * ふつうの3方向マージのほかに、**バージョン管理が人に判断を求める形**（片方が消して
 * 片方が直した／両方が同じ名前で別の中身を足した）も1件の競合として数える。
 */
function mergeAll(base, mine, theirs, merger) {
	const paths = new Set([...Object.keys(base), ...Object.keys(mine), ...Object.keys(theirs)]);
	const out = {};
	let conflicts = 0;
	const detail = [];
	for (const p of [...paths].sort()) {
		const b = base[p];
		const m = mine[p];
		const t = theirs[p];
		if (b === undefined) {
			if (m !== undefined && t !== undefined) {
				if (m === t) {
					out[p] = m;
					continue;
				}
				const r = merger(writeTriplet("", m, t));
				const n = countConflicts(r.text);
				conflicts += n;
				if (n > 0) {
					detail.push({ path: p, kind: "add/add", n });
				}
				out[p] = r.text;
				continue;
			}
			out[p] = m ?? t;
			continue;
		}
		if (m === undefined || t === undefined) {
			const survivor = m ?? t;
			if (survivor === undefined) {
				continue; // 両方が消した
			}
			if (survivor !== b) {
				// 片方が消して片方が直した。git も SVN も人に尋ねる
				conflicts += 1;
				detail.push({ path: p, kind: "modify/delete", n: 1 });
				out[p] = survivor;
			}
			continue;
		}
		if (m === t) {
			out[p] = m;
			continue;
		}
		const r = merger(writeTriplet(b, m, t));
		const n = countConflicts(r.text);
		conflicts += n;
		if (n > 0) {
			detail.push({ path: p, kind: "content", n });
		}
		out[p] = r.text;
	}
	return { files: out, conflicts, detail };
}

/* ------------------------------------------------------------------ *
 * 合流のあとに何が残っているか
 * ------------------------------------------------------------------ */

const FRONT = " front";

/** 世界から「あるべき状態」を出す */
function wantOf(w) {
	const want = new Map();
	for (const a of w) {
		for (const u of a.units) {
			want.set(`${a.path}\t${calculateHash(u.title)}`, `${calculateHash(u.body)}\t${u.from}\t${u.need}`);
		}
		if (a.front) {
			want.set(`${a.path}\t${FRONT}`, `${a.front.hash}\t${a.front.from}\t${a.front.need}`);
		}
	}
	return want;
}

const MARKER_LINE = /^<!--\s*mdait\b.*-->\s*$/;

/** 合流後のファイル一式から「実際に読める状態」を出す */
function gotOf(files, mode) {
	const got = new Map();
	const held = new Map();
	const push = (key, value, isHeld) => {
		if (!got.has(key)) {
			got.set(key, new Set());
		}
		got.get(key).add(value);
		if (isHeld) {
			held.set(key, (held.get(key) ?? 0) + 1);
		}
	};
	for (const entry of loadState2(files[".mdait/unit-state"] ?? "")) {
		const key = entry.kind === "front" ? `${entry.path}\t${FRONT}` : `${entry.path}\t${entry.titleHash}`;
		push(key, `${entry.hash}\t${entry.from}\t${entry.need}`, entry.kind === "held");
	}
	if (mode === "embedded") {
		for (const [p, content] of Object.entries(files)) {
			if (!isMd(p)) {
				continue;
			}
			const lines = content.split("\n");
			let marker = null;
			let inFront = false;
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				if (i === 0 && line === "---") {
					inFront = true;
					continue;
				}
				if (inFront) {
					if (line === "---") {
						inFront = false;
						continue;
					}
					const fm = line.match(/^mdait:\s*'(.*)'\s*$/);
					if (fm) {
						const m = MdaitMarker.parse(`<!-- mdait ${fm[1]} -->`);
						if (m) {
							push(`${p}\t${FRONT}`, `${m.hash}\t${m.from ?? ""}\t${m.need ?? ""}`, false);
						}
					}
					continue;
				}
				if (MARKER_LINE.test(line)) {
					marker = MdaitMarker.parse(line);
					continue;
				}
				const h = line.match(/^(#{1,6})\s+(.*)$/);
				if (h && marker) {
					push(
						`${p}\t${calculateHash(h[2].trim())}`,
						`${marker.hash}\t${marker.from ?? ""}\t${marker.need ?? ""}`,
						false,
					);
					marker = null;
				}
			}
		}
	}
	return { got, held };
}

function score(expected, files, mode) {
	const want = wantOf(expected);
	const { got, held } = gotOf(files, mode);
	let lost = 0;
	for (const [k, v] of want) {
		if (!got.get(k)?.has(v)) {
			lost++;
		}
	}
	let ghost = 0;
	for (const [k, vs] of got) {
		const extra = want.has(k) ? vs.size - 1 : vs.size;
		ghost += Math.max(0, extra - (held.get(k) ?? 0));
	}
	return { lost, ghost };
}

/* ------------------------------------------------------------------ *
 * 手順
 * ------------------------------------------------------------------ */

const SMALL_FRONT = world(SMALL).map(withFront);
/** 各記事の第1〜3章がまだ訳されていない世界（翻訳そのものを測るための base） */
const SMALL_TODO = (() => {
	const w = world(SMALL);
	for (const a of w) {
		for (const u of a.units.slice(1)) {
			u.from = "";
			u.need = "translate";
		}
	}
	return w;
})();
const MIXED = world([...SMALL, ...FLAT.slice(0, 4)]);

const SCENARIOS = [
	// --- 別のユニットどうし（merge.mjs の S5/S6 と同じ形を、原稿込みで測る） ---
	{ id: "X1", name: "同じ記事の離れた章をそれぞれ改訂", base: SMALL, a: [editChapter("a3", "記事3")], b: [editChapter("a3", "a3第3章")] },
	{ id: "X2", name: "同じ記事の隣り合う章をそれぞれ改訂", base: SMALL, a: [editChapter("a3", "a3第1章")], b: [editChapter("a3", "a3第2章")] },
	// --- 挿入 × 編集 ---
	{ id: "X3", name: "章を挿入／すぐ隣の章を改訂", base: SMALL, a: [insertChapter("a3", "a3第2章", "割り込み章")], b: [editChapter("a3", "a3第2章")] },
	{ id: "X4", name: "章を挿入／離れた章を改訂", base: SMALL, a: [insertChapter("a3", "a3第1章", "割り込み章")], b: [editChapter("a3", "a3第3章")] },
	// --- 削除 × 編集／翻訳 ---
	{ id: "X5", name: "章を削除／同じ記事の別の章を改訂", base: SMALL, a: [deleteChapter("a3", "a3第1章")], b: [editChapter("a3", "a3第3章")] },
	{ id: "X6", name: "章を削除／すぐ隣の章を翻訳", base: SMALL_TODO, a: [deleteChapter("a3", "a3第1章")], b: [transChapter("a3", "a3第2章")] },
	{ id: "X7", name: "章を削除／同じ章を改訂（本物の競合）", base: SMALL, a: [deleteChapter("a3", "a3第2章")], b: [editChapter("a3", "a3第2章")], expectConflict: true, expected: [deleteChapter("a3", "a3第2章")] },
	// --- sync だけ × trans まで ---
	{ id: "X8", name: "片方は sync だけ／片方は同じ記事の別の章を翻訳", base: SMALL_TODO, a: [syncSourceEdit("a3", "a3第1章")], b: [transChapter("a3", "a3第3章")] },
	{ id: "X9", name: "片方は sync だけ／片方は同じ章を翻訳（本物の競合）", base: SMALL_TODO, a: [syncSourceEdit("a3", "a3第2章")], b: [transChapter("a3", "a3第2章")], expectConflict: true },
	// --- 原文の編集 × 訳文の手編集（同じユニット） ---
	{ id: "X10", name: "原文を編集（sync 済）／同じユニットの訳文だけ手編集", base: SMALL, a: [syncSourceEdit("a3", "a3第2章")], b: [editTargetOnly("a3", "a3第2章")], expectConflict: true },
	{ id: "X11", name: "原文を編集（sync 済）／隣のユニットの訳文だけ手編集", base: SMALL, a: [syncSourceEdit("a3", "a3第2章")], b: [editTargetOnly("a3", "a3第3章")] },
	// --- 章の分割 ---
	{ id: "X12", name: "章を分割／同じ記事の離れた章を改訂", base: SMALL, a: [splitChapter("a3", "a3第2章", "分割後半")], b: [editChapter("a3", "記事3")] },
	{ id: "X13", name: "章を分割／その章そのものを改訂（本物の競合）", base: SMALL, a: [splitChapter("a3", "a3第2章", "分割後半")], b: [editChapter("a3", "a3第2章")], expectConflict: true },
	// --- リネーム・移動 ---
	{ id: "X14", name: "記事を改名（追随あり）／別の記事を改訂", base: SMALL, a: [renameFollow("a2", "a2-renamed")], b: [editChapter("a4", "a4第2章")] },
	{ id: "X15", name: "記事を改名（追随あり）／その記事の章を改訂", base: SMALL, a: [renameFollow("a2", "a2-renamed")], b: [editChapter("a2", "a2第2章")], expectConflict: true, expected: [editChapter("a2", "a2第2章"), renameFollow("a2", "a2-renamed")] },
	{ id: "X16", name: "フォルダ移動（追随あり・5本）／1本を改訂", base: SMALL, a: [moveAllToSub()], b: [editChapter("a4", "a4第2章")], expectConflict: true, expected: [editChapter("a4", "a4第2章"), moveAllToSub()] },
	// --- ファイルの追加（席・台帳の衝突） ---
	{ id: "X17", name: "両方が同じ名前で別の記事を追加（本物の競合）", base: SMALL, a: [addArticle("n1", ["新A", "新A章"])], b: [addArticle("n1", ["新B", "新B章"])], expectConflict: true },
	{ id: "X18", name: "両方が隣り合う名前の記事を追加", base: SMALL, a: [addArticle("a3a", ["新A", "新A章"])], b: [addArticle("a3b", ["新B", "新B章"])] },
	{ id: "X19", name: "同じディレクトリへ両方が5本ずつ追加", base: SMALL, a: Array.from({ length: 5 }, (_, i) => addArticle(`p${i}`, [`新p${i}`, `新p${i}章`])), b: Array.from({ length: 5 }, (_, i) => addArticle(`q${i}`, [`新q${i}`, `新q${i}章`])) },
	// --- verify-deletion / 保留席 ---
	{ id: "X20", name: "verify-deletion を立てる／同じ記事の別の章を改訂", base: SMALL, a: [verifyDeletion("a3", "a3第1章")], b: [editChapter("a3", "a3第3章")] },
	{ id: "X21", name: "2章まとめて削除（保留席が生まれる）／別の章を翻訳", base: SMALL_TODO, a: [deleteChapter("a3", "a3第1章"), deleteChapter("a3", "a3第3章")], b: [transChapter("a3", "a3第2章")] },
	{ id: "X22", name: "章を削除／同じ記事の末尾に追記", base: SMALL, a: [deleteChapter("a3", "a3第2章")], b: [insertChapter("a3", null, "末尾追記")] },
	// --- frontmatter ---
	{ id: "X23", name: "frontmatter を改訂／同じ記事の第1章を改訂", base: SMALL_FRONT, a: [editFront("a3")], b: [editChapter("a3", "記事3")] },
	{ id: "X24", name: "frontmatter を翻訳／同じ記事へ章を挿入", base: SMALL_FRONT, a: [translateFront("a3")], b: [insertChapter("a3", "a3第1章", "割り込み章")] },
	{ id: "X25", name: "別々の記事の frontmatter をそれぞれ改訂", base: SMALL_FRONT, a: [editFront("a2")], b: [editFront("a3")] },
	{ id: "X26", name: "同じ記事の frontmatter を両方が触る（本物の競合）", base: SMALL_FRONT, a: [editFront("a3")], b: [translateFront("a3")], expectConflict: true },
	// --- 記事の削除 × その記事への編集 ---
	{ id: "X27", name: "記事を1本削除／その記事の章を翻訳（本物の競合）", base: SMALL_TODO, a: [deleteArticle("a3")], b: [transChapter("a3", "a3第2章")], expectConflict: true, expected: [deleteArticle("a3")] },
	{ id: "X28", name: "記事を1本削除／別の記事へ章を挿入", base: SMALL, a: [deleteArticle("a3")], b: [insertChapter("a4", "a4第1章", "割り込み章")] },
	// --- MD と非MD が混ざる ---
	{ id: "X29", name: "混在: .md の章を改訂／.txt を改訂", base: MIXED, a: [editChapter("a3", "a3第2章")], b: [editFlat("t02")] },
	{ id: "X30", name: "混在: .txt を1本削除／.md へ章を挿入", base: MIXED, a: [deleteFlat("t03")], b: [insertChapter("a2", "a2第1章", "割り込み章")] },
	// --- 大きな作業場 ---
	// --- 翻訳そのもの（`merge.mjs` の S4 は base が全章翻訳済みのため無変化だった） ---
	{ id: "X32", name: "別々の記事の章をそれぞれ翻訳", base: SMALL_TODO, a: [transChapter("a1", "a1第2章")], b: [transChapter("a4", "a4第2章")] },
	{ id: "X33", name: "同じ記事の隣り合う2章をそれぞれ翻訳", base: SMALL_TODO, a: [transChapter("a3", "a3第1章")], b: [transChapter("a3", "a3第2章")] },
	{ id: "X34", name: "同じ記事の離れた2章をそれぞれ翻訳", base: SMALL_TODO, a: [transChapter("a3", "a3第1章")], b: [transChapter("a3", "a3第3章")] },
	{ id: "X35", name: "同じ章を2人が別々に翻訳（本物の競合）", base: SMALL_TODO, a: [transChapter("a3", "a3第2章")], b: [(w) => { const u = w.find((x) => x.path === "content/en/a3.md").units[2]; u.from = calculateHash(u.body); u.body = "a3第2章 のもう1つの訳文"; u.need = ""; return w; }], expectConflict: true },
	{ id: "X36", name: "1人が記事まるごと翻訳／1人がその記事へ章を挿入", base: SMALL_TODO, a: [transChapter("a3", "a3第1章"), transChapter("a3", "a3第2章"), transChapter("a3", "a3第3章")], b: [insertChapter("a3", "a3第2章", "割り込み章")], expectConflict: true },
	{ id: "X31", name: "20記事: 両方が8本ずつ追加（重い日）", base: BIG, a: Array.from({ length: 8 }, (_, i) => addArticle(`e${i}`, [`新e${i}`, `新e${i}章`])), b: Array.from({ length: 8 }, (_, i) => addArticle(`f${i}`, [`新f${i}`, `新f${i}章`])) },
];

/* ------------------------------------------------------------------ *
 * 実行
 * ------------------------------------------------------------------ */

const MODES = ["external", "embedded"];

function runScenario(scenario, dump) {
	const base = scenario.base;
	const mine = apply2(base, ...scenario.a);
	const theirs = apply2(base, ...scenario.b);
	// 「片方が消し、もう片方が直した」形は b をそのまま重ねられないので、
	// 手で解いたあとの姿を手順ごとに指定できるようにする
	const expected = scenario.expected ? apply2(base, ...scenario.expected) : apply2(mine, ...scenario.b);
	const result = {
		id: scenario.id,
		name: scenario.name,
		expectConflict: !!scenario.expectConflict,
		modes: {},
	};
	for (const mode of MODES) {
		const baseFiles = filesOf(base, mode, "");
		const priorState = baseFiles[".mdait/unit-state"] ?? "";
		const mineFiles = filesOf(mine, mode, priorState);
		const theirsFiles = filesOf(theirs, mode, priorState);
		result.modes[mode] = {};
		for (const [way, merger] of Object.entries(MERGERS)) {
			const merged = mergeAll(baseFiles, mineFiles, theirsFiles, merger);
			const { lost, ghost } = score(expected, merged.files, mode);
			result.modes[mode][way] = { conflicts: merged.conflicts, lost, ghost, detail: merged.detail };
			if (dump && dump.id === scenario.id) {
				const dir = path.join(dump.dir, `${scenario.id}-${mode}-${way}`);
				const write = (sub, obj) => {
					for (const [p, c] of Object.entries(obj)) {
						const f = path.join(dir, sub, p);
						fs.mkdirSync(path.dirname(f), { recursive: true });
						fs.writeFileSync(f, c, "utf-8");
					}
				};
				write("base", baseFiles);
				write("mine", mineFiles);
				write("theirs", theirsFiles);
				write("merged", merged.files);
			}
		}
	}
	return result;
}

function report(results) {
	console.log("\n合流のあとに何が残るか（競合 / 消失 / 増殖）— **原稿の .md も合流させて数えている**\n");
	console.log(`  ${pad("", 5)}${pad("手順", 44)}${pad("external", 33)}${pad("embedded", 33)}`);
	console.log(
		`  ${pad("", 5)}${pad("", 44)}${pad("git", 11)}${pad("diff3", 11)}${pad("union", 11)}${pad("git", 11)}${pad("diff3", 11)}${pad("union", 11)}`,
	);
	console.log(`  ${"-".repeat(115)}`);
	for (const r of results) {
		const cell = (mode, way) => {
			const c = r.modes[mode][way];
			return `${c.conflicts}/${c.lost}/${c.ghost}`;
		};
		const mark = r.expectConflict ? "*" : " ";
		let line = `  ${pad(`${r.id}${mark}`, 5)}${pad(r.name, 44)}`;
		for (const mode of MODES) {
			for (const way of ["git", "diff3", "union"]) {
				line += pad(cell(mode, way), 11);
			}
		}
		console.log(line);
	}
	console.log("\n  * は「原稿そのものが競合する手順」。ここで競合が出るのは正しい。");
	const plain = results.filter((r) => !r.expectConflict);
	console.log("\n  合計（* を除く）");
	for (const mode of MODES) {
		const parts = ["git", "diff3", "union"].map((way) => {
			const s = (k) => plain.reduce((n, r) => n + r.modes[mode][way][k], 0);
			return `${pad(way, 7)}競合 ${pad(String(s("conflicts")), 4)}消失 ${pad(String(s("lost")), 4)}増殖 ${s("ghost")}`;
		});
		console.log(`    ${pad(mode, 10)}${parts.join("　")}`);
	}
	console.log("\n  競合が出た内訳（* を含む全手順・git）");
	for (const r of results) {
		for (const mode of MODES) {
			const d = r.modes[mode].git.detail;
			if (d.length === 0) {
				continue;
			}
			console.log(
				`    ${pad(r.id, 5)}${pad(mode, 10)}${d.map((x) => `${x.path}(${x.kind}x${x.n})`).join(", ")}`,
			);
		}
	}
}

/* ------------------------------------------------------------------ *
 * 3人以上が同じ base から分かれて、順に合流する
 * ------------------------------------------------------------------ */

/**
 * base から N 人が分かれ、A+B → その結果 +C … と順に合流させる。
 *
 * 2人目までしか測らないと「合流のあとのファイルへ3人目が合流する」形を1度も踏まない。
 * 3人目の合流の base は**元の base**（枝分かれ点）なので、2人分の変更が同時に相手側へ
 * 現れる — 2人合流より難しい場面になる。
 */
const CHAINS = [
	{
		id: "C1",
		name: "3人が同じ記事の別々の章を翻訳",
		base: SMALL_TODO,
		branches: [
			[transChapter("a3", "a3第1章")],
			[transChapter("a3", "a3第2章")],
			[transChapter("a3", "a3第3章")],
		],
	},
	{
		id: "C2",
		name: "3人が別々の記事を翻訳",
		base: SMALL_TODO,
		branches: [
			[transChapter("a1", "a1第1章")],
			[transChapter("a3", "a3第2章")],
			[transChapter("a5", "a5第3章")],
		],
	},
	{
		id: "C3",
		name: "3人がそれぞれ別の記事を1本ずつ追加",
		base: SMALL,
		branches: [
			[addArticle("n1", ["新1", "新1章"])],
			[addArticle("n2", ["新2", "新2章"])],
			[addArticle("n3", ["新3", "新3章"])],
		],
	},
	{
		id: "C4",
		name: "1人が章を挿入・1人が隣を改訂・1人が別の記事を翻訳",
		base: SMALL_TODO,
		branches: [
			[insertChapter("a3", "a3第2章", "割り込み章")],
			[editChapter("a3", "a3第3章")],
			[transChapter("a1", "a1第1章")],
		],
	},
	{
		id: "C5",
		name: "4人が同じ記事へ順に章を足す",
		base: SMALL,
		branches: [
			[insertChapter("a3", "a3第1章", "割り込み1")],
			[insertChapter("a3", "a3第2章", "割り込み2")],
			[insertChapter("a3", "a3第3章", "割り込み3")],
			[editChapter("a3", "記事3")],
		],
	},
];

function runChain(chain) {
	const result = { id: chain.id, name: chain.name, modes: {} };
	for (const mode of MODES) {
		const baseFiles = filesOf(chain.base, mode, "");
		const prior = baseFiles[".mdait/unit-state"] ?? "";
		const branchFiles = chain.branches.map((edits) => filesOf(apply2(chain.base, ...edits), mode, prior));
		result.modes[mode] = {};
		for (const [way, merger] of Object.entries(MERGERS)) {
			let acc = branchFiles[0];
			let conflicts = 0;
			const steps = [];
			for (let i = 1; i < branchFiles.length; i++) {
				const merged = mergeAll(baseFiles, acc, branchFiles[i], merger);
				conflicts += merged.conflicts;
				steps.push(merged.conflicts);
				acc = merged.files;
			}
			// 最後の姿から、全員の翻訳が読めるか
			let expected = clone2(chain.base);
			for (const edits of chain.branches) expected = apply2(expected, ...edits);
			const { lost, ghost } = score(expected, acc, mode);
			result.modes[mode][way] = { conflicts, steps, lost, ghost };
		}
	}
	return result;
}

function reportChain(results) {
	console.log("\n3人以上が順に合流したとき（競合 / 消失 / 増殖）\n");
	console.log(`  ${pad("", 5)}${pad("手順", 44)}${pad("external", 33)}${pad("embedded", 33)}`);
	console.log(
		`  ${pad("", 5)}${pad("", 44)}${pad("git", 11)}${pad("diff3", 11)}${pad("union", 11)}${pad("git", 11)}${pad("diff3", 11)}${pad("union", 11)}`,
	);
	console.log(`  ${"-".repeat(115)}`);
	for (const r of results) {
		let line = `  ${pad(r.id, 5)}${pad(r.name, 44)}`;
		for (const mode of MODES) {
			for (const way of ["git", "diff3", "union"]) {
				const c = r.modes[mode][way];
				line += pad(`${c.conflicts}/${c.lost}/${c.ghost}`, 11);
			}
		}
		console.log(line);
	}
}

/* ------------------------------------------------------------------ *
 * 台帳（unit-registry）: 足す件数を変えたときの競合率と、GC が絡む形
 * ------------------------------------------------------------------ */

const { UnitRegistryStore } = require(path.join(REPO, "out/core/unit-registry/unit-registry-store.js"));

function seeded(seed) {
	let x = seed >>> 0;
	return () => {
		x = (x * 1664525 + 1013904223) >>> 0;
		return x / 0x100000000;
	};
}

const serializeRegistry = (hashes, notes = new Map()) => {
	const store = new UnitRegistryStore();
	for (const h of hashes) store.upsert(h, "eJxLyU", notes.get(h));
	return `${store.serialize()}\n`;
};

function registryTrial(seed, { baseCount, addCount, gc = 0, note = false }) {
	const rand = seeded(seed);
	const hex = () => Array.from({ length: 8 }, () => "0123456789abcdef"[Math.floor(rand() * 16)]).join("");
	const base = new Set();
	while (base.size < baseCount) base.add(hex());
	const mine = new Set(base);
	while (mine.size < baseCount + addCount) mine.add(hex());
	// もう片方は GC（古い控えを捨てる）か、追加か
	const theirs = new Set(base);
	if (gc > 0) {
		const victims = [...base].slice(0, gc);
		for (const v of victims) theirs.delete(v);
	} else {
		while (theirs.size < baseCount + addCount) theirs.add(hex());
	}
	const theirNotes = new Map();
	if (note) {
		for (const h of [...base].slice(0, 5)) theirNotes.set(h, "note-added");
	}
	const files = writeTriplet(
		serializeRegistry(base),
		serializeRegistry(mine),
		serializeRegistry(theirs, theirNotes),
	);
	const out = {};
	for (const [way, merger] of Object.entries(MERGERS)) {
		const merged = merger(files);
		const store = new UnitRegistryStore();
		store.parse(merged.text);
		const want = gc > 0 ? mine : new Set([...mine, ...theirs]);
		let lost = 0;
		for (const h of want) {
			if (store.get(h) === null) lost++;
		}
		out[way] = { conflicts: countConflicts(merged.text), lost };
	}
	return out;
}

function runRegistry(trials = 200) {
	const shapes = [
		{ label: "2000件へ両側10件ずつ追加", baseCount: 2000, addCount: 10 },
		{ label: "2000件へ両側30件ずつ追加", baseCount: 2000, addCount: 30 },
		{ label: "2000件へ両側100件ずつ追加", baseCount: 2000, addCount: 100 },
		{ label: "2000件へ両側300件ずつ追加", baseCount: 2000, addCount: 300 },
		{ label: "20000件へ両側100件ずつ追加", baseCount: 20000, addCount: 100 },
		{ label: "片方が30件追加／片方が GC で30件削除", baseCount: 2000, addCount: 30, gc: 30 },
		{ label: "片方が30件追加／片方が note を5件足す", baseCount: 2000, addCount: 30, note: true },
	];
	console.log("\n台帳（unit-registry）の合流\n");
	console.log(`  ${pad("形", 40)}${pad("git", 22)}${pad("diff3", 22)}${pad("union", 22)}`);
	console.log(`  ${"-".repeat(104)}`);
	for (const shape of shapes) {
		const totals = { git: { c: 0, l: 0 }, diff3: { c: 0, l: 0 }, union: { c: 0, l: 0 } };
		const n = shape.baseCount > 5000 ? Math.min(trials, 40) : trials;
		for (let i = 0; i < n; i++) {
			const r = registryTrial(9000 + i, shape);
			for (const way of Object.keys(totals)) {
				if (r[way].conflicts > 0) totals[way].c++;
				totals[way].l += r[way].lost;
			}
		}
		let line = `  ${pad(shape.label, 40)}`;
		for (const way of ["git", "diff3", "union"]) {
			line += pad(`競合 ${totals[way].c}/${n}　消失 ${totals[way].l}`, 22);
		}
		console.log(line);
	}
}

export function run({ only, out, dump, dumpdir, chain, registry } = {}) {
	const wanted = only ? new Set(String(only).split(",").map((s) => s.trim())) : undefined;
	const d = dump ? { id: dump, dir: dumpdir ?? path.join(TMP, "dump") } : undefined;
	if (d) {
		fs.mkdirSync(d.dir, { recursive: true });
	}
	const results = SCENARIOS.filter((s) => !wanted || wanted.has(s.id)).map((s) => runScenario(s, d));
	report(results);
	let chains;
	if (chain) {
		chains = CHAINS.map(runChain);
		reportChain(chains);
	}
	if (registry) {
		runRegistry();
	}
	if (d) {
		console.log(`\n合流の入出力を書き出しました: ${d.dir}`);
	}
	if (typeof out === "string" && out) {
		fs.writeFileSync(out, `${JSON.stringify({ results, chains }, null, 2)}\n`, "utf-8");
		console.log(`\n数字を書き出しました: ${out}`);
	}
	return { results };
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const args = process.argv.slice(2);
	const opt = (name) => {
		const i = args.indexOf(`--${name}`);
		return i >= 0 ? args[i + 1] : undefined;
	};
	run({
		only: opt("only"),
		out: opt("out"),
		dump: opt("dump"),
		dumpdir: opt("dumpdir"),
		chain: args.includes("--chain"),
		registry: args.includes("--registry"),
	});
}
