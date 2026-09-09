#!/usr/bin/env node
/*
 * 台帳の掃除の実験場（調査用・CI 非対象）。
 *
 * 何を測る道具か
 * --------------
 * `unit-registry`（`need:revise@X` の戻り先を控えてある表）の掃除が、**翻訳者が対象言語を
 * 絞って作業している回に、絞った先の言語の控えを消すかどうか**を測る。
 *
 * 掃除が消してよいのは「誰も使っていない控え」だけである。ところが控えはハッシュしか鍵に
 * 持たないので、「使っている」を数えるほうを取りこぼすと、生きている控えが消える。削除は
 * 競合を出さないふつうの差分なので、そのまま全員へ伝播する。
 *
 * 3通りの集め方を同じ世界に当てる。
 *   selected  … 選んだペアの原稿だけを見る（**掃除の走査を sync の作業範囲に合わせた形**）
 *   skip      … 絞って走らせた回は掃除ごと見送る
 *   all       … 選択に関わらず config の全ペアを見る（いまの製品の形）
 *
 * 掃除そのものは**製品の `UnitRegistryManager.garbageCollect()`** を通す。走査も製品の
 * `sweepMarkerHashes` を通す。ここに出る消失はそのまま実機で起きる消失である。
 *
 * 使い方
 * ------
 *   node scripts/lab/scenarios/registry-gc-probe.mjs
 *   node scripts/lab/scenarios/registry-gc-probe.mjs --langs 5 --articles 40
 *
 * 前提: `npm run compile` 済みであること（out/ の製品コードを読む）。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// vscode モックを先に登録する（UnitRegistryManager は vscode.workspace.fs で書く）
require(path.join(REPO, "src/test/unit/__mocks__/register-vscode-mock.js"));

const { UnitRegistryManager } = require(path.join(REPO, "out/core/unit-registry/unit-registry-manager.js"));
const { sweepMarkerHashes } = require(path.join(REPO, "out/commands/sync/registry-sweep.js"));
const { UnitStateStore } = require(path.join(REPO, "out/core/unit-state/unit-state-store.js"));
const { Configuration } = require(path.join(REPO, "out/infra/config/configuration.js"));
const { ExternalMarkerProvider } = require(path.join(REPO, "out/core/markdown/marker-provider.js"));
const { MdaitMarker } = require(path.join(REPO, "out/core/markdown/mdait-marker.js"));
const { MdaitUnit } = require(path.join(REPO, "out/core/markdown/mdait-unit.js"));

const args = process.argv.slice(2);
const readOpt = (name, fallback) => {
	const at = args.indexOf(name);
	return at >= 0 && args[at + 1] ? Number(args[at + 1]) : fallback;
};
const LANGS = readOpt("--langs", 3); // 訳文の言語数
const ARTICLES = readOpt("--articles", 30); // 1言語あたりの記事数
const CHAPTERS = 4; // 1記事あたりの章数
const GC_THRESHOLD = 5 * 1024 * 1024;

const hex8 = () => crypto.randomBytes(4).toString("hex");
/** gzip で縮まない中身（縮むと閾値に届かない） */
const bulk = () => crypto.randomBytes(2500).toString("base64");

/* ------------------------------------------------------------------ *
 * 世界を作る
 * ------------------------------------------------------------------ */

/**
 * 原文 docs/ja と訳文 docs/<lang> を作り、章ごとに埋め込みマーカーを書く。
 * 訳文の一部には `need:revise@<旧hash>` を付ける（＝控えを引く必要がある章）。
 */
function buildWorkspace(ws, langs) {
	const live = new Set(); // いま原稿から参照されている印
	const reviseTargets = new Map(); // lang -> [旧hash...]（消えると改訂差分が引けない）

	const sourceHashes = [];
	for (let a = 0; a < ARTICLES; a++) {
		const lines = [];
		for (let c = 0; c < CHAPTERS; c++) {
			const h = hex8();
			sourceHashes.push(h);
			live.add(h);
			lines.push(`<!-- mdait ${h} -->`, `## 章 ${c}`, "", `原文の本文 ${a}-${c}`, "");
		}
		writeFile(path.join(ws, "docs/ja", `a${a}.md`), lines.join("\n"));
	}

	for (const lang of langs) {
		reviseTargets.set(lang, []);
		for (let a = 0; a < ARTICLES; a++) {
			const lines = [];
			for (let c = 0; c < CHAPTERS; c++) {
				const from = sourceHashes[a * CHAPTERS + c];
				const h = hex8();
				live.add(h);
				live.add(from);
				// 4章に1つ、改訂待ち（原文が変わったので訳し直してほしい章）
				if (c === 1) {
					const old = hex8();
					live.add(old);
					reviseTargets.get(lang).push(old);
					lines.push(`<!-- mdait ${h} from:${from} need:revise@${old} -->`);
				} else {
					lines.push(`<!-- mdait ${h} from:${from} -->`);
				}
				lines.push(`## Chapter ${c}`, "", `${lang} の訳文 ${a}-${c}`, "");
			}
			writeFile(path.join(ws, "docs", lang, `a${a}.md`), lines.join("\n"));
		}
	}
	return { live, reviseTargets };
}

function writeFile(file, content) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content, "utf-8");
}

/** 台帳を作る。生きている印を全部入れ、閾値を超えるまで死んだ印で水増しする */
async function buildRegistry(ws, live) {
	const mgr = UnitRegistryManager.getInstance();
	for (const h of live) {
		mgr.saveUnitRegistry(h, `${h}:${bulk()}`);
	}
	let dead = 0;
	const registryPath = path.join(ws, ".mdait", "unit-registry");
	for (;;) {
		for (let i = 0; i < 100; i++) {
			mgr.saveUnitRegistry(hex8(), `dead:${bulk()}`);
			dead++;
		}
		await mgr.flushBuffer();
		if (fs.statSync(registryPath).size > GC_THRESHOLD) break;
	}
	return { dead, bytes: fs.statSync(registryPath).size };
}

/* ------------------------------------------------------------------ *
 * 走らせる
 * ------------------------------------------------------------------ */

async function run() {
	const langs = Array.from({ length: LANGS }, (_, i) => ["en", "fr", "de", "es", "it", "pt"][i] ?? `l${i}`);
	const selected = langs[0]; // 翻訳者がその日選んでいる言語
	const others = langs.slice(1);

	const ws = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-gc-probe-"));
	globalThis.__vscodeMockWorkspaceRoot = ws;
	fs.mkdirSync(path.join(ws, ".mdait"), { recursive: true });

	console.log(`作業場: ${ws}`);
	console.log(`原文 docs/ja ＋ 訳文 ${langs.length} 言語（${langs.join(" / ")}）× ${ARTICLES} 記事 × ${CHAPTERS} 章`);
	console.log(`翻訳者はその日 **${selected} だけ**を選んで作業している\n`);

	const { live, reviseTargets } = buildWorkspace(ws, langs);
	const pristine = await buildRegistry(ws, live);
	const registryPath = path.join(ws, ".mdait", "unit-registry");
	const pristineBytes = fs.readFileSync(registryPath);
	UnitRegistryManager.resetInstance();

	const allDirs = [path.join(ws, "docs/ja"), ...langs.map((l) => path.join(ws, "docs", l))];
	const selectedDirs = [path.join(ws, "docs/ja"), path.join(ws, "docs", selected)];

	console.log(`台帳: 生きている印 ${live.size} 件 ＋ 死んだ印 ${pristine.dead} 件 = ${live.size + pristine.dead} 件`);
	console.log(`      ${(pristine.bytes / 1024 / 1024).toFixed(2)} MB（閾値 5MB 超。掃除が走る条件）\n`);

	// 走査の費用も測る
	const t0 = process.hrtime.bigint();
	const sweptAll = sweepMarkerHashes(allDirs, [".md"]);
	const sweepMs = Number(process.hrtime.bigint() - t0) / 1e6;
	const sweptSelected = sweepMarkerHashes(selectedDirs, [".md"]);

	const cases = [
		{
			key: "selected",
			label: "選んだペアの原稿だけを見る",
			skipped: false,
			hashes: sweptSelected.hashes,
		},
		{ key: "skip", label: "絞って走らせた回は掃除ごと見送る", skipped: true, hashes: null },
		{ key: "all", label: "選択に関わらず全ペアを見る（いまの形）", skipped: false, hashes: sweptAll.hashes },
	];

	const rows = [];
	for (const c of cases) {
		// 毎回まっさらな台帳から始める
		fs.writeFileSync(registryPath, pristineBytes);
		UnitRegistryManager.resetInstance();
		Configuration.dispose();
		const mgr = UnitRegistryManager.getInstance();

		let after = live.size + pristine.dead;
		if (!c.skipped) {
			await mgr.garbageCollect(new Set(c.hashes));
			after = countEntries(registryPath);
		}

		// 生きている印のうち、引けなくなったものを数える
		UnitRegistryManager.resetInstance();
		const reader = UnitRegistryManager.getInstance();
		let lostLive = 0;
		for (const h of live) {
			if ((await reader.loadUnitRegistry(h)) === null) lostLive++;
		}
		const lostRevise = {};
		for (const [lang, olds] of reviseTargets) {
			let lost = 0;
			for (const old of olds) {
				if ((await reader.loadUnitRegistry(old)) === null) lost++;
			}
			lostRevise[lang] = `${lost}/${olds.length}`;
		}
		rows.push({ ...c, after, lostLive, lostRevise });
	}

	/* ---- 表 ---- */
	const total = live.size + pristine.dead;
	console.log("| 印の集め方 | 掃除 | 台帳 | 消えた「生きている印」 | 改訂の戻り先が消えた数 |");
	console.log("|---|---|---|---|---|");
	for (const r of rows) {
		const revise = Object.entries(r.lostRevise)
			.map(([lang, v]) => `${lang} ${v}`)
			.join(" / ");
		console.log(
			`| ${r.label} | ${r.skipped ? "**見送り**" : "走った"} | ${total} → ${r.after} | ${r.lostLive} | ${revise} |`,
		);
	}

	console.log(`\n選んでいない言語（${others.join(" / ")}）の改訂の戻り先が消えれば、`);
	console.log("その翻訳者は「原文が変わりました」の差分を二度と引けない。");
	console.log("削除は競合を出さないので、合流でそのまま全員へ伝わる。\n");

	console.log("走査の費用");
	console.log(
		`  ${sweptAll.filesRead} ファイル（原文＋訳文 ${langs.length} 言語）を読んで ${sweepMs.toFixed(0)} ms、印 ${sweptAll.hashes.size} 件`,
	);
	console.log(`  選んだペアだけなら ${sweptSelected.filesRead} ファイル・印 ${sweptSelected.hashes.size} 件`);
	console.log(`  掃除は台帳が 5MB を超えた回にしか走らないので、この費用はその回だけ払う`);

	await runExternal(langs, selected, others);

	fs.rmSync(ws, { recursive: true, force: true });
	UnitStateStore.dispose();
}

/** external の同じ問い。守る印は原稿ではなく unit-state の行から集めるしかない */
async function runExternal(langs, selected, others) {
	const ws = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-gc-probe-ext-"));
	globalThis.__vscodeMockWorkspaceRoot = ws;
	const mdaitDir = path.join(ws, ".mdait");
	fs.mkdirSync(mdaitDir, { recursive: true });
	UnitRegistryManager.resetInstance();
	Configuration.dispose();

	const { live, reviseTargets } = buildExternalWorkspace(ws, langs);
	const pristine = await buildRegistry(ws, live);
	const registryPath = path.join(mdaitDir, "unit-registry");
	const pristineBytes = fs.readFileSync(registryPath);
	UnitRegistryManager.resetInstance();

	console.log(`\n\n========== external（マーカーは .mdait/unit-state にある） ==========\n`);
	console.log(`原稿にマーカーは無い。原稿の走査では印が1つも拾えないので、行から集めるしかない`);
	console.log(`台帳: 生きている印 ${live.size} 件 ＋ 死んだ印 ${pristine.dead} 件、${(pristine.bytes / 1024 / 1024).toFixed(2)} MB\n`);

	const cases = [
		{
			label: "選んだペアの行だけを見る",
			hashes: collectFromUnitState(mdaitDir, ["docs/ja", `docs/${selected}`]),
		},
		{ label: "unit-state の**全行**を見る（いまの形）", hashes: collectFromUnitState(mdaitDir, null) },
	];

	const total = live.size + pristine.dead;
	console.log("| 印の集め方 | 台帳 | 消えた「生きている印」 | 改訂の戻り先が消えた数 |");
	console.log("|---|---|---|---|");
	for (const c of cases) {
		fs.writeFileSync(registryPath, pristineBytes);
		UnitRegistryManager.resetInstance();
		await UnitRegistryManager.getInstance().garbageCollect(new Set(c.hashes));
		const after = countEntries(registryPath);

		UnitRegistryManager.resetInstance();
		const reader = UnitRegistryManager.getInstance();
		let lostLive = 0;
		for (const h of live) {
			if ((await reader.loadUnitRegistry(h)) === null) lostLive++;
		}
		const revise = [];
		for (const [lang, olds] of reviseTargets) {
			let lost = 0;
			for (const old of olds) {
				if ((await reader.loadUnitRegistry(old)) === null) lost++;
			}
			revise.push(`${lang} ${lost}/${olds.length}`);
		}
		console.log(`| ${c.label} | ${total} → ${after} | ${lostLive} | ${revise.join(" / ")} |`);
	}
	console.log(`\n選んでいない言語（${others.join(" / ")}）を守れるのは、行を全部見たときだけである。`);

	fs.rmSync(ws, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ *
 * external（マーカーが原稿ではなく .mdait/unit-state にある形）
 * ------------------------------------------------------------------ */

/**
 * 原稿にはマーカーを書かず、状態を `unit-state` に持つ世界を作る。
 * embedded と違って原稿の走査では何も拾えないので、守る印は行から集めるしかない。
 */
function buildExternalWorkspace(ws, langs) {
	const live = new Set();
	const reviseTargets = new Map();
	const mdaitDir = path.join(ws, ".mdait");

	UnitStateStore.dispose();
	const store = UnitStateStore.getInstance();
	store.load(mdaitDir);
	const provider = new ExternalMarkerProvider(store);

	const put = (relPath, role, chapters) => {
		const units = chapters.map(
			(c, i) => new MdaitUnit(new MdaitMarker(c.hash, null, null), `章 ${i}`, 2, c.body, 0, 0),
		);
		const ctx = { filePath: relPath, role };
		provider.attachMarkers(units, ctx);
		units.forEach((unit, i) => {
			unit.marker = new MdaitMarker(chapters[i].hash, chapters[i].from || null, chapters[i].need || null);
		});
		provider.detachMarkers(units, ctx);
		writeFile(path.join(ws, relPath), units.map((u, i) => `## 章 ${i}\n\n${chapters[i].body}\n`).join("\n"));
	};

	const sourceHashes = [];
	for (let a = 0; a < ARTICLES; a++) {
		const chapters = [];
		for (let c = 0; c < CHAPTERS; c++) {
			const h = hex8();
			sourceHashes.push(h);
			live.add(h);
			chapters.push({ hash: h, body: `原文の本文 ${a}-${c}` });
		}
		put(`docs/ja/a${a}.md`, "source", chapters);
	}

	for (const lang of langs) {
		reviseTargets.set(lang, []);
		for (let a = 0; a < ARTICLES; a++) {
			const chapters = [];
			for (let c = 0; c < CHAPTERS; c++) {
				const from = sourceHashes[a * CHAPTERS + c];
				const h = hex8();
				live.add(h);
				live.add(from);
				let need = null;
				if (c === 1) {
					const old = hex8();
					live.add(old);
					reviseTargets.get(lang).push(old);
					need = `revise@${old}`;
				}
				chapters.push({ hash: h, from, need, body: `${lang} の訳文 ${a}-${c}` });
			}
			put(`docs/${lang}/a${a}.md`, "target", chapters);
		}
	}

	store.save(mdaitDir);
	return { live, reviseTargets };
}

/** unit-state の行から印を集める（`dirs` を渡すとその配下の行だけ＝選んだペアだけを見る形） */
function collectFromUnitState(mdaitDir, dirs) {
	UnitStateStore.dispose();
	const store = UnitStateStore.getInstance();
	store.load(mdaitDir);
	const hashes = new Set();
	for (const entry of store.getAllEntries()) {
		if (dirs && !dirs.some((d) => entry.path.startsWith(`${d}/`))) continue;
		for (const value of [entry.hash, entry.from]) {
			if (value) hashes.add(value.toLowerCase());
		}
		const at = entry.need.indexOf("@");
		if (at >= 0) hashes.add(entry.need.slice(at + 1).toLowerCase());
	}
	return hashes;
}

/** 台帳の実エントリ数（区画の目印の行は数えない） */
function countEntries(file) {
	let n = 0;
	for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
		if (/^[0-9a-f]{8} /.test(line)) n++;
	}
	return n;
}

run().catch((error) => {
	console.error(error);
	process.exit(1);
});
