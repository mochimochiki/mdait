#!/usr/bin/env node
/*
 * 決まった手順のスイープ — mdait の「機構」を端から確かめる。
 *
 * 見るのは次の14。P1〜P8 は旧 scripts/exploratory/run-sweep.js をそのまま引き継いでいる。
 *   P1-sync          マーカーの形が揃っているか / need:translate が付くか / 2回目で何も変わらないか
 *   P2-trans         翻訳すると need:translate が消えるか / そのあと sync しても変わらないか
 *   P3-revise        原文を書き換えると need:revise@もとのハッシュ が付くか
 *   P4-nonmd         Markdown でないファイル（txt / csv / json）でも同じことが起きるか
 *   P5-external      マーカーを外へ出したあと、本文にマーカーが残らず sync も変わらないか
 *   P6-modeswitch    設定を書き換えるだけで本文の表現が付いたり外れたりし、増えも振れもしないか
 *   P7-nosilentdelete 本文が一時的に崩れても、外の台帳（unit-state）の行を黙って消さないか
 *   P8-nobodyloss    原文のフェンスが崩れても、訳文の本文がまとめて消えないか
 *   P9-term          用語の検出・展開が原稿を触らず、用語集の行を失わず、2回流しても変わらないか
 *   P10-tm           翻訳メモリへの登録が「確定した対訳」だけを拾い、理由つきで残りを見送るか
 *   P11-aireview     訳文レビューが訳文を書き換えないか（レビュー本体は headless では走らない）
 *   P12-adopt        既にある訳を取り込んでも本文が1文字も変わらず、あとから上書きもされないか
 *   P13-edge         端の原稿（空マーカー・コードブロック内の見本・空ファイル・frontmatter だけ）
 *   P14-level        見出しレベルの設定どおりに境目が決まり、変えても本文が失われないか
 *
 * 判定は2つに分ける。この分け方は「狼が来た」を防ぐための決まりなので、勝手に変えないこと。
 *   FAIL … 製品の側の不具合。1件でもあれば終了コード 1
 *   INFO … 確かめる道具の側の限界（偽の AI では再現できない、対象の見本が無い、など）
 *
 * 動かし方
 *   node scripts/lab/lab.mjs sweep          （まとめ役が配線する呼び方）
 *   node scripts/lab/scenarios/sweep.mjs    （単独。実験場が無ければ自分で起こして、終わったら止める）
 *     --verbose   通った判定（OK）も1件ずつ出す
 *     --only P1,P5   見たい分だけ（P1〜P3 はひと続きなので、途中だけ選ぶと前提が揃わない。
 *                    P4 以降は段ごとに作業場を作り直すので、1つだけ選んでも成り立つ）
 *     --keep      単独で動かしたとき、終わっても実験場を止めない
 *
 * 手順の出し方
 *   mdait のコマンドはすべて土台のファイル IPC（lib/ipc.mjs の sendCommand）を通す。
 *   `lab run` と同じ道なので、1手順ずつ run ディレクトリに全文が残る。
 *   土台に無い操作（設定ファイルの書き換え、原稿の細工）はここで直にファイルを触る。
 *   例外は P7 だけで、そこで叩く parse / stringify / embedFileMarkers はコマンドではないため
 *   このプロセスから直に呼ぶ（理由はその場にも書いてある）。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "../lib/args.mjs";
import { sendCommand } from "../lib/ipc.mjs";
import { saveStep } from "../lib/runs.mjs";
import { LAB_DIR, readSession } from "../lib/session.mjs";
import { configureAi, prepareWorkspace } from "../lib/workspace.mjs";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const LAB = path.join(REPO, "scripts", "lab", "lab.mjs");

/** マーカーの厳密な形。ここから外れるものは壊れているとみなす */
const MARKER_STRICT = /<!-- mdait(?:\s+([a-zA-Z0-9]+))?(?:\s+from:([a-zA-Z0-9]+))?(?:\s+need:([\w@-]+))?\s*-->/;
/** マーカーらしきものを拾うゆるい形（壊れたものも拾うため） */
const MARKER_LOOSE = /<!--\s*mdait\b[^>]*-->/g;

/** out/ の中を読む近道。コンパイル済みの本体を直に読む */
function out(rel) {
	return require(path.join(REPO, "out", rel));
}

// コードブロックの中に書かれた「マーカーの書き方の見本」を本物と数えないために要る。
// 中身は markdown-it を使うだけの純粋な関数なので、vscode の肩代わりを立てる前に読んでよい。
const { getCodeBlockLineSet } = out("core/markdown/code-block-lines.js");

// ===========================================================================
// 判定の記録
// ===========================================================================

/** 1回のスイープで見つけたことを全部ここへ積む */
let findings = [];
/** 通った判定も出すか */
let verbose = false;

function say(text = "") {
	process.stdout.write(`${text}\n`);
}

function fail(phase, file, summary, detail) {
	findings.push({ sev: "FAIL", phase, file, summary, detail: detail ?? "" });
	say(`  [FAIL] (${phase}) ${file}: ${summary}`);
}

function info(phase, file, summary) {
	findings.push({ sev: "INFO", phase, file, summary, detail: "" });
	say(`  [INFO] (${phase}) ${file}: ${summary}`);
}

function ok(phase, summary) {
	findings.push({ sev: "OK", phase, file: "-", summary, detail: "" });
	if (verbose) say(`  [OK]   (${phase}) ${summary}`);
}

/** その段で何件ずつ出たかを数える */
function tallyOf(phase, from) {
	const mine = findings.slice(from).filter((f) => f.phase === phase);
	return {
		ok: mine.filter((f) => f.sev === "OK").length,
		info: mine.filter((f) => f.sev === "INFO").length,
		fail: mine.filter((f) => f.sev === "FAIL").length,
	};
}

// ===========================================================================
// 作業場を見るための下ごしらえ
// ===========================================================================

/** いま使っている作業場。run() の最初に決める */
let ws = "";
/** 記録の置き場。無ければ手順の保存は見送る */
let runDir = null;
/** 作業場の作り方（tmp / repo / パス）。作り直すときに要る */
let wsMode = "tmp";
/** AI の相手の情報（作り直すと設定が雛形へ戻るので、そのたび差し向け直す） */
let aiInfo = null;

function contentDir() {
	return path.join(ws, "content");
}

function configFile() {
	return path.join(ws, ".mdait", "mdait.json");
}

function read(file) {
	return fs.readFileSync(file, "utf8");
}

/** 作業場の原稿を端から並べる */
function walkFiles(dir, acc = []) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walkFiles(full, acc);
		else acc.push(full);
	}
	return acc;
}

/** 原稿を丸ごと控える（相対パス → 中身）。前後で見比べて「変わったか」を見るのに使う */
function snapshot() {
	const map = {};
	for (const file of walkFiles(contentDir())) map[path.relative(contentDir(), file)] = read(file);
	return map;
}

/**
 * 本文にあるマーカーを並べる。
 * コードブロックの中の「書き方の見本」は本文であってマーカーではないので除く
 * （除かないと見本を本物と数えて誤って騒ぐ）。
 */
function markerLines(content) {
	const codeBlockLines = getCodeBlockLineSet(content);
	const found = [];
	content.split("\n").forEach((line, at) => {
		if (codeBlockLines.has(at)) return;
		const matched = line.match(MARKER_LOOSE);
		if (matched) found.push(...matched);
	});
	return found;
}

/** マーカーの need を取り出す（無ければ空文字） */
function needFlag(markerText) {
	const matched = MARKER_STRICT.exec(markerText);
	return matched?.[3] || "";
}

/** 本文のマーカーを {hash, from, need} の形で並べる（コードブロックの中の見本は除く） */
function markerInfo(content) {
	return markerLines(content).map((marker) => {
		const matched = MARKER_STRICT.exec(marker);
		return { hash: matched?.[1] || "", from: matched?.[2] || "", need: matched?.[3] || "" };
	});
}

/**
 * マーカーの行を取り除いた本文を返す。
 * 既にある訳が取り込み（adopt）で1文字も変わっていないかを見るのに使う。
 * コードブロックの中の「マーカーの書き方の見本」は本文なので残す。
 */
function bodyWithoutMarkers(content) {
	const codeBlockLines = getCodeBlockLineSet(content);
	return content
		.split("\n")
		.filter((line, at) => codeBlockLines.has(at) || !/<!--\s*mdait\b/.test(line))
		.join("\n");
}

/** 見出しの深さを並べる（コードブロックの中は数えない） */
function headingLevels(content) {
	const codeBlockLines = getCodeBlockLineSet(content);
	const levels = [];
	content.split("\n").forEach((line, at) => {
		if (codeBlockLines.has(at)) return;
		const matched = /^(#{1,6})\s/.exec(line);
		if (matched) levels.push(matched[1].length);
	});
	return levels;
}

/** 控えた原稿を2つ見比べて、中身が変わったファイルを並べる */
function changedFiles(before, after) {
	const changed = [];
	for (const rel of new Set([...Object.keys(before), ...Object.keys(after)])) {
		if (before[rel] !== after[rel]) changed.push(rel);
	}
	return changed.sort();
}

/** 用語集のファイル（設定の terms.filename。既定は terms.csv） */
function glossaryFile() {
	const json = JSON.parse(read(configFile()));
	return path.join(ws, ".mdait", json.terms?.filename ?? "terms.csv");
}

/** 翻訳メモリのファイル */
function tmxFile() {
	return path.join(ws, ".mdait", "translations.tmx");
}

/** ファイルがあれば中身を、無ければ空文字を返す */
function readIfExists(file) {
	return fs.existsSync(file) ? read(file) : "";
}

/** その手順で出た知らせ・確認ダイアログの文言を並べる（返り値を持たないコマンドの結果を読むのに使う） */
function dialogMessages(result) {
	return (result?.dialogs ?? []).map((dialog) => String(dialog.message ?? ""));
}

/** 控えた原稿ぜんぶで、need が指定の頭で始まるマーカーを数える */
function countNeed(map, prefix) {
	let count = 0;
	for (const content of Object.values(map)) {
		for (const marker of markerLines(content)) if (needFlag(marker).startsWith(prefix)) count += 1;
	}
	return count;
}

/** 本文（frontmatter でないところ）にマーカーが残っている .md を並べる。外へ出したあとは 0 のはず */
function filesWithBodyMarkers(map) {
	const found = [];
	for (const [rel, content] of Object.entries(map)) {
		if (!rel.endsWith(".md")) continue;
		const codeBlockLines = getCodeBlockLineSet(content);
		content.split("\n").forEach((line, at) => {
			if (codeBlockLines.has(at)) return;
			if (/<!--\s*mdait\b/.test(line) && !line.includes("front")) found.push(rel);
		});
	}
	return [...new Set(found)];
}

/** 外の台帳（.mdait/unit-state）をそのまま読む。無ければ空文字 */
function readUnitState() {
	const file = path.join(ws, ".mdait", "unit-state");
	return fs.existsSync(file) ? read(file) : "";
}

/**
 * 外の台帳の行を取り出す。
 *
 * 絞り込みは必ずパスの**厳密一致**で行う。見本には `child2_1.md` と `child2_2.md` のように
 * 頭がぶつかる名前があり、「含む」で探すと別のファイルの行まで拾ってしまう。
 *
 * @param {string} relPath 作業場から見た相対パス
 * @returns {Array<{path:string, order:number, level:number, titleHash:string, hash:string, from:string, need:string}>}
 */
function unitStateRows(relPath) {
	const rows = [];
	for (const line of readUnitState().split("\n")) {
		if (line.trim() === "" || line.startsWith("#")) continue;
		const cols = line.split("\t");
		if (cols.length !== 7) continue;
		if (relPath !== undefined && cols[0] !== relPath) continue;
		rows.push({
			path: cols[0],
			order: Number(cols[1]),
			level: Number(cols[2]),
			titleHash: cols[3],
			hash: cols[4],
			from: cols[5],
			need: cols[6],
		});
	}
	return rows;
}

/** 台帳の全行（絞り込みなし） */
function allUnitStateRows() {
	return unitStateRows(undefined);
}

/** そのファイルの「中身としての状態」を1本の文字列で表す（並び順は含めない） */
function stateOfRows(rows) {
	return rows
		.map((row) => `${row.hash}/${row.from}/${row.need}`)
		.sort()
		.join(" ");
}

// ===========================================================================
// 土台を通した手順
// ===========================================================================

/**
 * コマンドを1つ実行して、結果を run ディレクトリへ残す。
 * `lab run` とまったく同じ道を通る。
 */
async function runCmd(command, args = []) {
	const result = await sendCommand(ws, command, args, { timeoutSec: 900 });
	if (runDir) {
		try {
			saveStep(runDir, command, result, { args, ws });
		} catch {
			// 記録に失敗しても確かめること自体は続ける
		}
	}
	return result;
}

/** sync を1回。失敗したらそこで打ち切る（以降の判定が意味を持たなくなるため） */
async function sync() {
	const result = await runCmd("mdait.sync");
	if (result.status === "error") throw new Error(`mdait.sync が失敗しました: ${result.error}`);
	return result.result ?? {};
}

/** 1ファイルを翻訳する。例外も結果として受け取れるよう、そのまま返す */
async function trans(absPath) {
	return await runCmd("mdait.trans", [absPath]);
}

/** ディスクを入れ替えたあと、ホストに覚えている中身を捨てて読み直してもらう */
async function reload() {
	const result = await runCmd("lab.reload");
	if (result.status === "error") throw new Error(`ホストの読み直しに失敗しました: ${result.error}`);
}

/**
 * 設定ファイルへ、その段だけの追加設定を書く（読み直しはしない）。
 *
 * 指定しなかった追加設定は毎回まっさらに戻す。前の段の設定が残ると、
 * 関係のないところで結果が変わってしまうため。
 * AI の差し向け（ai）はここでは触らない。土台が偽の AI へ向けた設定をそのまま使う。
 */
function applyConfig(extra = {}) {
	const json = JSON.parse(read(configFile()));
	if (json.trans) {
		// undefined を入れておくと JSON へ書き出すときに落ちる（キーごと消えるのと同じ）
		json.trans = { ...json.trans, extensions: undefined };
	}
	if (extra.extensions !== undefined) json.trans = { ...(json.trans ?? {}), extensions: extra.extensions };
	if (extra.markersMode !== undefined) json.markers = { mode: extra.markersMode };
	else json.markers = undefined;
	// 見出しレベル（ユニットの境目の深さ）。指定が無ければ雛形の値へ戻す
	if (json.sync) json.sync = { ...json.sync, level: extra.level ?? templateLevel() };
	fs.writeFileSync(configFile(), `${JSON.stringify(json, null, 2)}\n`, "utf8");
}

/** 雛形（src/test/unit/workspace/.mdait/mdait.json）の見出しレベル。指定が無いときはここへ戻す */
let templateLevelCache = null;
function templateLevel() {
	if (templateLevelCache === null) {
		const template = JSON.parse(read(path.join(REPO, "src", "test", "unit", "workspace", ".mdait", "mdait.json")));
		templateLevelCache = template.sync?.level ?? 3;
	}
	return templateLevelCache;
}

/** 設定を書き換えて、ホストにも読み直してもらう */
async function switchConfig(extra = {}) {
	applyConfig(extra);
	await reload();
}

/**
 * 作業場を見本から作り直す。
 *
 * 段と段のあいだで状態が持ち越されないようにするために要る。原稿だけでなく、
 * 外の台帳（unit-state）とユニット台帳（unit-registry）も捨て、ホストが覚えている
 * 中身も読み直させる。
 */
async function resetWs(extra = {}) {
	await prepareWorkspace({ mode: wsMode, reset: true });
	// 作り直すと設定は雛形へ戻るので、偽の AI への差し向けを付け直す
	if (aiInfo?.baseURL) configureAi(ws, { mode: aiInfo.mode, baseURL: aiInfo.baseURL });
	applyConfig(extra);
	await reload();
}

// ===========================================================================
// 直に触る道具（土台が肩代わりできないところだけ）
// ===========================================================================

let inprocReady = false;

/**
 * このプロセスでも out/ の中身を呼べるようにする。
 *
 * ふつうの手順はホスト（別のプロセス）が受け持つ。ここを使うのは P7 の1か所だけで、
 * そこで叩く parse / stringify / embedFileMarkers は**コマンドではない**ため、
 * ファイル IPC では届かない。ディスクへ書いたあとは必ずホストに読み直させてから先へ進む。
 * 確認ダイアログへの答え方は vscode-shim.js に任せる（ホストと同じ振る舞いにするため）。
 */
function bootInproc() {
	if (inprocReady) return;
	global.__mdaitLabWorkspaceRoot = ws;
	process.env.MDAIT_LAB_WS = ws;
	// 「AI を初めて使いますが良いですか」の確認は、答えられないここでは飛ばしてもらう
	process.env.MDAIT_DEBUG_IPC = "1";
	require(path.join(REPO, "scripts", "lab", "vscode-shim.js"));

	// 一覧の組み立てなどが出す細かい知らせは、判定の見通しを悪くするので伏せる
	const original = console.log;
	console.log = (...args) => {
		const head = String(args[0] ?? "");
		if (head.startsWith("StatusManager:") || head.startsWith("DefaultAIProvider")) return;
		original(...args);
	};
	inprocReady = true;
}

/** このプロセスが覚えている中身を捨てて、ディスクから読み直す */
async function inprocReload() {
	bootInproc();
	out("core/unit-registry/unit-registry-manager.js").UnitRegistryManager.resetInstance();
	out("core/unit-state/unit-state-store.js").UnitStateStore.dispose();
	await out("infra/config/configuration.js").Configuration.getInstance().load();
	const selection = out("core/status/selection-state.js").SelectionState.getInstance();
	selection.updateSelection(selection.getSelectableTargets().map((target) => target.key));
}

/** 読み込み済みの外の台帳を返す（このプロセスの分） */
function inprocStore() {
	const { UnitStateStore } = out("core/unit-state/unit-state-store.js");
	const store = UnitStateStore.getInstance();
	store.ensureLoaded(path.join(ws, ".mdait"));
	return store;
}

// ===========================================================================
// P1 — sync
// ===========================================================================

async function phase1() {
	const P = "P1-sync";
	const first = await sync();
	const snap1 = snapshot();

	let broken = 0;
	for (const [rel, content] of Object.entries(snap1)) {
		if (!rel.endsWith(".md")) continue;
		for (const marker of markerLines(content)) {
			const matched = MARKER_STRICT.exec(marker);
			if (!matched) {
				broken += 1;
				fail(P, rel, "マーカーが厳密文法に不一致", marker);
				continue;
			}
			for (const hash of [matched[1], matched[2]]) {
				if (hash && !/^[0-9a-f]{8}$/.test(hash)) fail(P, rel, `ハッシュが8桁hexでない: ${hash}`, marker);
			}
		}
	}
	if (broken === 0) ok(P, `マーカー整合OK (${Object.keys(snap1).length}ファイル)`);

	const needTranslate = countNeed(snap1, "translate");
	if (needTranslate > 0) ok(P, `need:translate 付与 ${needTranslate}件`);
	else fail(P, "-", "sync後に need:translate が1件も無い", JSON.stringify(first));

	const second = await sync();
	const snap2 = snapshot();
	if (second.totalAdded !== 0 || second.totalModified !== 0) {
		fail(P, "-", `2回目 sync が非冪等 (added=${second.totalAdded}, modified=${second.totalModified})`, "");
	}
	let diffed = 0;
	for (const rel of new Set([...Object.keys(snap1), ...Object.keys(snap2)])) {
		if (snap1[rel] !== snap2[rel]) {
			diffed += 1;
			fail(P, rel, "2回目 sync でファイル内容が変化（非冪等）", "byte diff");
		}
	}
	if (diffed === 0 && second.totalAdded === 0 && second.totalModified === 0) ok(P, "sync 冪等性OK（2回目で無変化）");

	await untranslatedCopyFollowsSource(P);
}

/**
 * **まだ訳していない訳文は、いまの原文の丸写しである。**
 *
 * この不変条件が破れると、`need:translate` のまま `hash`（訳文の中身）と `from`（原文の中身）が
 * 食い違い、人が一度も触っていないユニットが Decoration で「編集済み」を名乗る（ツリーは同じ
 * ユニットを「未翻訳」と出すので、2つのサーフェスが食い違う）。訳文に古い原文の丸写しが
 * 残り続けるという実害もある。
 *
 * 原文を書き換えて sync し、訳文が追いついたかを見る。見終わったら原文を1バイト単位で戻し、
 * 続く段（P2・P3）が前提としている初期状態を崩さない。
 */
async function untranslatedCopyFollowsSource(P) {
	const srcFile = path.join(contentDir(), "ja/business.md");
	const tgtFile = path.join(contentDir(), "en/business.md");
	if (!fs.existsSync(srcFile) || !fs.existsSync(tgtFile)) {
		info(P, "ja/business.md", "見本が無いので未訳の追随を確かめられない", "");
		return;
	}
	const srcBefore = read(srcFile);
	const tgtBefore = read(tgtFile);
	const marker = "## エグゼクティブサマリー";
	if (!srcBefore.includes(marker)) {
		info(P, "ja/business.md", "目印の見出しが見本に無い", marker);
		return;
	}

	fs.writeFileSync(srcFile, srcBefore.replace(marker, `${marker}（改訂）`), "utf8");
	await sync();

	const tgtAfter = read(tgtFile);
	if (!tgtAfter.includes(`${marker}（改訂）`)) {
		fail(P, "en/business.md", "未訳の丸写しが古い原文のまま取り残された", marker);
	} else {
		ok(P, "未訳の丸写しが変わった原文へ追随した");
	}
	const broken = markerInfo(tgtAfter).filter((m) => m.need === "translate" && m.from && m.hash !== m.from);
	if (broken.length > 0) {
		fail(
			P,
			"en/business.md",
			`未訳なのに hash≠from のユニットが ${broken.length}件（触っていないのに「編集済み」と出る）`,
			JSON.stringify(broken[0]),
		);
	} else {
		ok(P, "未訳ユニットの hash と from が一致している");
	}

	// 続く段のために原文を戻す（戻せば訳文の丸写しも元へ追随する）
	fs.writeFileSync(srcFile, srcBefore, "utf8");
	await sync();
	if (read(srcFile) !== srcBefore || read(tgtFile) !== tgtBefore) {
		fail(P, "business.md", "原文を戻しても初期状態に戻らない（後片付けの失敗）", "byte diff");
	}
}

// ===========================================================================
// P2 — trans
// ===========================================================================

async function phase2() {
	const P = "P2-trans";
	const targets = walkFiles(contentDir()).filter(
		(file) => file.endsWith(".md") && markerLines(read(file)).some((m) => needFlag(m).startsWith("translate")),
	);
	ok(P, `need:translate を含む target: ${targets.length}ファイル`);

	let translated = 0;
	for (const target of targets) {
		const rel = path.relative(contentDir(), target);
		const result = await trans(target);
		if (result.status === "error") {
			fail(P, rel, "transCommand が例外", String(result.error));
			continue;
		}
		translated += result.result?.translatedCount ?? 0;
		const after = read(target);
		const remain = markerLines(after).filter((m) => needFlag(m).startsWith("translate")).length;
		if (remain > 0) fail(P, rel, `trans後も need:translate が ${remain}件残存`, "");
		for (const marker of markerLines(after)) {
			if (!MARKER_STRICT.exec(marker)) fail(P, rel, "trans後にマーカー破損", marker);
		}
	}
	ok(P, `translatedCount 合計 ${translated}`);

	const before = snapshot();
	await sync();
	const after = snapshot();
	let diffed = 0;
	for (const rel of new Set([...Object.keys(before), ...Object.keys(after)])) {
		if (before[rel] !== after[rel]) diffed += 1;
	}
	if (diffed === 0) ok(P, "trans後 re-sync 冪等OK");
	else info(P, "-", `trans後 re-sync で ${diffed}ファイル変化（偽の訳文の付け直しによる。実物の AI で要確認）`);
}

// ===========================================================================
// P3 — revise
// ===========================================================================

async function phase3() {
	const P = "P3-revise";
	const srcFile = path.join(contentDir(), "ja/10_test.md");
	const tgtFile = path.join(contentDir(), "en/10_test.md");
	fs.writeFileSync(
		srcFile,
		read(srcFile).replace("# 見出し 1", "# 見出し 1\n\n原文をここで変更した（revise誘発）。"),
		"utf8",
	);

	const result = await sync();
	const reviseMarks = markerLines(read(tgtFile)).filter((m) => needFlag(m).startsWith("revise"));
	if (reviseMarks.length === 0) {
		fail(P, "en/10_test.md", "原文変更後の re-sync で need:revise が付与されない", JSON.stringify(result));
	} else if (reviseMarks.every((m) => /need:revise@[0-9a-f]{8}/.test(m))) {
		ok(P, `need:revise@oldhash 付与OK (${reviseMarks.length}件)`);
	} else {
		fail(P, "en/10_test.md", "need:revise が @oldhash 形式でない", reviseMarks.join(" | "));
	}

	const transResult = await trans(tgtFile);
	if (transResult.status === "error") {
		info(P, "en/10_test.md", `revise trans 例外（偽の AI の限界）: ${String(transResult.error)}`);
		return;
	}
	const value = transResult.result ?? {};
	// 偽の AI は差分（targetPatch）の形を作れないので、当てはめは必ずここで失敗する。
	// そのあとどうなるか（訳し直すか、そのまま残すか）は確認への答え方で変わるので、
	// 「差分そのものは試せていない」ことだけは必ず控える。実物の AI で確かめること。
	if ((value.patchFailures?.length ?? 0) > 0) {
		info(
			P,
			"en/10_test.md",
			"revise の差分（targetPatch）は偽の AI では作れず、当てはめに失敗した（実物の AI で要確認）",
		);
	}
	const remain = markerLines(read(tgtFile)).filter((m) => needFlag(m).startsWith("revise")).length;
	if (remain > 0) {
		info(
			P,
			"en/10_test.md",
			`revise trans後も need:revise が ${remain}件残存（差分を作れなかったぶん。実物の AI で要確認）`,
		);
	} else {
		ok(P, `revise trans後 need クリア (patched=${value.patchedCount}, translated=${value.translatedCount})`);
	}
}

// ===========================================================================
// P4 — Markdown でないファイル
// ===========================================================================

async function phase4() {
	const P = "P4-nonmd";
	await resetWs({ extensions: [".txt", ".csv", ".json"] });

	const first = await sync();
	const rows1 = readUnitState();
	const nonMd = allUnitStateRows().filter((row) => row.path.endsWith(".txt") || row.path.endsWith(".csv"));
	if (nonMd.length > 0) ok(P, `非MD unit-state エントリ ${nonMd.length}件`);
	else fail(P, "-", "非MD (txt/csv) が unit-state に登録されない（extensions 経路の退行）", JSON.stringify(first));

	const second = await sync();
	const rows2 = readUnitState();
	if (rows1 === rows2 && second.totalAdded === 0 && second.totalModified === 0) {
		ok(P, "非MD sync 冪等性OK（2回目で unit-state 無変化）");
	} else {
		fail(
			P,
			"-",
			`非MD sync が非冪等 (added=${second.totalAdded}, modified=${second.totalModified}, us-stable=${rows1 === rows2})`,
			"",
		);
	}

	// txt を訳して need が消えるか
	await transAndCheckNeed(P, "content/en/notice.txt", "非MD trans 後に need クリアOK");

	// JSON も例外なく訳し切れるか（need が残らないこと）。
	// 「JSON を訳すと need:review が立つ」偽陽性はここでは測れない。偽の AI が波括弧を落とすため、
	// JSON 混入の検出がそもそも動かない。その退行は単体テスト（plain-translation-review.test.ts）で守る。
	await transAndCheckNeed(P, "content/en/config-sample.json", "JSON 翻訳後に need クリアOK");

	// 字下げした本文が訳されるか。Markdown の「4スペース＝コードブロック」を Markdown でない
	// ファイルに当てると、字下げの行が AI に渡らず訳文に原文が残る。
	const outlineRel = "content/en/outline.txt";
	const outlineAbs = path.join(ws, outlineRel);
	const outlineResult = await trans(outlineAbs);
	if (outlineResult.status === "error") {
		fail(P, outlineRel, "outline transCommand が例外", String(outlineResult.error));
	} else {
		const body = read(outlineAbs);
		const untouched = ["    背景", "    目的", "    体制", "    - 検索が速くなりました"].filter((line) =>
			body.includes(line),
		);
		if (untouched.length === 0) ok(P, "非MDの字下げ本文も翻訳されるOK");
		else fail(P, outlineRel, `字下げ本文が原文のまま残る（${untouched.length}行）`, untouched.join(" / "));
	}

	// 原文を書き換えたら revise@もとのハッシュ が付くか
	const src = path.join(contentDir(), "ja/notice.txt");
	fs.writeFileSync(src, `${read(src)}\n追記（revise誘発）\n`, "utf8");
	await sync();
	const rows = unitStateRows("content/en/notice.txt");
	const need = rows[0]?.need ?? "";
	if (/^revise@[0-9a-f]{8}$/.test(need)) ok(P, `非MD revise@oldhash 付与OK (${need})`);
	else fail(P, "content/en/notice.txt", `非MD 原文変更後に revise@oldhash が付かない: '${need}'`, JSON.stringify(rows));
}

/** 1ファイル訳して、外の台帳の need が空になったかを見る */
async function transAndCheckNeed(P, relPath, okMessage) {
	const absPath = path.join(ws, relPath);
	const result = await trans(absPath);
	if (result.status === "error") {
		fail(P, relPath, `${path.extname(relPath)} の transCommand が例外`, String(result.error));
		return;
	}
	const rows = unitStateRows(relPath);
	const need = rows[0]?.need ?? "";
	if (need === "") ok(P, okMessage);
	else fail(P, relPath, `翻訳後も need 残存: ${need}`, JSON.stringify(rows));
}

// ===========================================================================
// P5 — マーカーを外へ出す（正規の道すじ）
// ===========================================================================

async function phase5() {
	const P = "P5-external";
	await resetWs();
	// まず既定（本文に埋める）で sync してマーカーを確定させる
	await sync();

	// マーカーを外へ出す（「本当に書き換えますか」の確認には土台が代わりに答える）
	const externalized = await runCmd("mdait.markers.externalize");
	if (externalized.status === "error") fail(P, "-", "externalize が失敗した", String(externalized.error));

	const afterExternalize = snapshot();
	const leftover = filesWithBodyMarkers(afterExternalize);
	if (leftover.length === 0) ok(P, "externalize 後に本文マーカー無しOK");
	else fail(P, leftover[0], `externalize 後も本文にマーカーが残存 (${leftover.length}ファイル)`, leftover.join(", "));

	// 外へ出す設定を明示して読み直す（externalize が設定を書き戻しているが、念のため揃える）
	await switchConfig({ markersMode: "external" });
	await sync();
	const md1 = snapshot();
	const us1 = readUnitState();
	const second = await sync();
	const md2 = snapshot();
	const us2 = readUnitState();

	let diffed = 0;
	for (const rel of new Set([...Object.keys(md1), ...Object.keys(md2)])) {
		if (md1[rel] !== md2[rel]) diffed += 1;
	}
	if (diffed === 0 && us1 === us2 && second.totalAdded === 0 && second.totalModified === 0) {
		ok(P, "external sync 冪等性OK（本文・unit-state とも無変化）");
	} else {
		fail(
			P,
			"-",
			`external sync が非冪等 (mdDiff=${diffed}, us-stable=${us1 === us2}, added=${second.totalAdded}, modified=${second.totalModified})`,
			"",
		);
	}
}

// ===========================================================================
// P6 — 設定を書き換えるだけの切り替え
// ===========================================================================

async function phase6() {
	const P = "P6-modeswitch";
	await resetWs();
	await sync();
	const embedded = filesWithBodyMarkers(snapshot());
	if (embedded.length > 0) ok(P, `embedded 基準: 本文マーカーを持つMD ${embedded.length}ファイル`);
	else fail(P, "-", "embedded 基準で本文マーカーが1つも無い（前提崩れ）", "");

	// 設定だけ外へ出す側に切り替えて sync
	await switchConfig({ markersMode: "external" });
	await sync();
	const externalLeft = filesWithBodyMarkers(snapshot());
	if (externalLeft.length === 0) ok(P, "external 切替 sync 後に本文マーカー無しへ自己修復OK");
	else {
		fail(
			P,
			externalLeft[0],
			`external 切替後も本文にマーカー残存 (${externalLeft.length}ファイル＝非冪等成長の原因)`,
			externalLeft.join(", "),
		);
	}
	const md1 = snapshot();
	const us1 = readUnitState();
	await sync();
	if (JSON.stringify(md1) === JSON.stringify(snapshot()) && us1 === readUnitState())
		ok(P, "external 切替後 sync 冪等OK");
	else fail(P, "-", "external 切替後の sync が非冪等", "");

	// 設定を本文に埋める側へ戻して sync
	await switchConfig();
	await sync();
	const backEmbedded = filesWithBodyMarkers(snapshot());
	if (backEmbedded.length > 0) ok(P, "embedded 復帰 sync 後に本文マーカーが書き戻るOK");
	else fail(P, "-", "embedded 復帰後も本文にマーカーが戻らない", "");
	const mdRowsLeft = allUnitStateRows().filter((row) => row.path.endsWith(".md")).length;
	if (mdRowsLeft === 0) ok(P, "embedded 復帰後 unit-state から MD エントリが除去されるOK");
	else fail(P, "-", `embedded 復帰後も unit-state に MD エントリ残存 (${mdRowsLeft}件)`, "");

	// 冪等かどうかは「同じ姿へ落ち着くか」で見る。
	// 大事なのは「際限なく増えたり行き来したりせず、何回かで落ち着く」ことなので、それを確かめる。
	let prev = snapshot();
	let converged = false;
	let rounds = 0;
	for (let i = 0; i < 4; i += 1) {
		await sync();
		const current = snapshot();
		rounds += 1;
		if (JSON.stringify(prev) === JSON.stringify(current)) {
			converged = true;
			break;
		}
		prev = current;
	}
	if (converged) ok(P, `embedded 復帰後 sync が固定点へ収束OK（${rounds}回で安定・増殖なし）`);
	else fail(P, "-", "embedded 復帰後の sync が4回でも収束しない（成長/振動の疑い）", "");
}

// ===========================================================================
// P7 — 外の台帳の行を黙って消さない
// ===========================================================================

/*
 * ここで見たいのは「本文が一時的に崩れたまま読み書きされたとき」である（ADR-260803-03）。
 * sync は必ず「同期後のユニット列」へ書き直してから外の台帳へ渡すので、崩れた列は届かない。
 * 崩れた本文がそのまま読み書きされるのは CodeLens の操作（unit-mutation）と
 * マーカーの引っ越し（markers-migration）の経路で、その2つを直に叩いて確かめる。
 * どちらもコマンドではないので、ホストからは呼べない。このプロセスで呼び、
 * ディスクへ書いたあとはホストに読み直させてから sync する。
 */
async function phase7() {
	const P = "P7-nosilentdelete";
	await resetWs();
	await sync();
	await switchConfig({ markersMode: "external" });
	await sync();

	await inprocReload();
	const { Configuration } = out("infra/config/configuration.js");
	const { isFrontMatterEntry } = out("core/unit-state/unit-state-store.js");
	const { markdownParser } = out("core/markdown/parser.js");
	const { resolveMarkerIOForFile } = out("infra/config/marker-io.js");
	const { embedFileMarkers } = out("commands/markers/markers-migration.js");
	const store = inprocStore();

	// 訳文側で行が多いファイルを選ぶ（刈り取りの境目あたりを見たいので4行以上）。
	// 原文側の行は本文からハッシュを作り直せるので、消えても sync が作り直してしまい
	// 「状態を失った」ことが見えない。守りたいのは from / need を持つ訳文側の行である。
	const perPath = {};
	for (const entry of store.getAllEntries()) {
		if (!entry.path.endsWith(".md")) continue;
		// 見たいのは「本文のユニットが何行あるか」なので、本文の並びに属さない frontmatter は数えない
		if (isFrontMatterEntry(entry)) continue;
		perPath[entry.path] = perPath[entry.path] ?? { total: 0, withFrom: 0 };
		perPath[entry.path].total += 1;
		if (entry.from !== "") perPath[entry.path].withFrom += 1;
	}
	// **選び方を決め打ちにする。** かつては Map の走査順に頼っていたので、`unit-state` の
	// 並べ方を変えただけで対象ファイルが入れ替わり、判定が揺れた（実測: 並べ方を変えた回だけ
	// この検査が落ち、製品の振る舞いは何も変わっていなかった）。
	//
	// 元からコードフェンスを含むファイルは除く — 下で `\`\`\`text` で包んでも**その
	// ファイル自身のフェンスで早々に閉じてしまい**、狙った「以降が全部飲まれる」状態に
	// ならない（実測: 11ユニットが9ユニットにしか減らず、刈り取りが正当に働いて落ちた）。
	const relPath = Object.keys(perPath)
		.filter((p) => perPath[p].total >= 4 && perPath[p].withFrom >= 3)
		.filter((p) => !read(path.join(ws, p)).includes("```"))
		.sort()[0];
	if (!relPath) {
		info(P, "-", "from を持つ行が4件以上でコードフェンスを含まない訳文 .md が無く、刈り取り閾値まわりを検証できない");
		return;
	}
	const absPath = path.join(ws, relPath);
	const original = read(absPath);
	const beforeRows = store.getEntriesByPath(relPath).length;
	const beforeState = stateOfRows(unitStateRows(relPath));

	// ---- (a) 本文が一時的に崩れた状態で読み書きしても行を失わない ----
	// コードブロックの閉じ忘れ。以降が全部コードとして飲まれ、ユニットが激減する。
	fs.writeFileSync(absPath, `${original.split("\n")[0]}\n\n\`\`\`text\n${original}\n`, "utf8");
	const brokenIO = resolveMarkerIOForFile(Configuration.getInstance(), absPath);
	const brokenDoc = markdownParser.parse(read(absPath), Configuration.getInstance(), brokenIO.provider, brokenIO.ctx);
	if (brokenDoc.units.length >= beforeRows) {
		info(P, relPath, `フェンスを崩してもユニットが減らず（${brokenDoc.units.length}件）刈り取り判定を通せない`);
	}
	markdownParser.stringify(brokenDoc, brokenIO.provider, brokenIO.ctx);
	const afterBroken = store.getEntriesByPath(relPath).length;
	if (afterBroken >= beforeRows) {
		ok(P, `フェンス崩れの本文を書き換えても行が減らないOK（${relPath}: ${beforeRows}→${afterBroken}）`);
	} else {
		fail(P, relPath, `フェンス崩れで unit-state の行が消えた（${beforeRows}→${afterBroken}）`, "");
	}

	// 崩れを直すと状態が戻る（保留席の行が中身で拾い直される）。
	// 行の数だけ見ても sync が作り直すので戻って見える。from / need まで一致するかを見る。
	store.save(path.join(ws, ".mdait"));
	fs.writeFileSync(absPath, original, "utf8");
	await reload();
	await sync();
	const restoredState = stateOfRows(unitStateRows(relPath));
	if (restoredState === beforeState) {
		ok(P, `崩れを直すと from/need が元に戻るOK（${relPath}）`);
	} else {
		fail(P, relPath, "崩れを直しても from/need が元に戻らない", `before=${beforeState}\nafter =${restoredState}`);
	}

	// ---- (b) 本文へ書き戻せなかった行を消さない ----
	// 本文を先頭のユニットだけに削り、行のほうが多い状態で書き戻す。
	await inprocReload();
	const store2 = inprocStore();
	const head = original.split("\n").slice(0, 2).join("\n");
	fs.writeFileSync(absPath, `${head}\n`, "utf8");
	const rowsBeforeEmbed = store2.getEntriesByPath(relPath).length;
	embedFileMarkers(absPath, "target", Configuration.getInstance(), store2);
	const rowsAfterEmbed = store2.getEntriesByPath(relPath).length;
	if (rowsBeforeEmbed > 1 && rowsAfterEmbed > 0) {
		ok(P, `embed で書き戻せなかった行が残るOK（${relPath}: ${rowsBeforeEmbed}→${rowsAfterEmbed}）`);
	} else if (rowsBeforeEmbed <= 1) {
		info(P, relPath, "embed 前の行が1件以下で、書き戻せない行を作れなかった");
	} else {
		fail(P, relPath, `embed が書き戻せなかった行まで削除した（${rowsBeforeEmbed}→0）`, "");
	}

	fs.writeFileSync(absPath, original, "utf8");
}

// ===========================================================================
// P8 — 訳文の本文がまとめて消えない
// ===========================================================================

/** 見出しの数を数える */
function headingsOf(text) {
	return (text.match(/^#{1,6}\s.*$/gm) || []).length;
}

/*
 * 行を守っても本文が消えていては意味が無い（ADR-260803-05）。既定の設定では、原文に
 * コードブロックの閉じ忘れが1つ入るだけで以降の見出しが全部コードとして飲まれ、
 * 対応を失った訳文の章がまとめて物理削除されていた（実測で7章が消え、直しても戻らなかった）。
 */
async function phase8() {
	const P = "P8-nobodyloss";
	await resetWs({ markersMode: "external" });
	await sync();

	const relPath = "content/ja/40_structure_mismatch.md";
	const absSrc = path.join(ws, relPath);
	const absTgt = path.join(ws, relPath.replace("/ja/", "/en/"));
	if (!fs.existsSync(absSrc) || !fs.existsSync(absTgt)) {
		info(P, relPath, "対象ファイルが見つからず、フェンス崩れを検証できない");
		return;
	}
	const originalSrc = read(absSrc);
	const originalTgt = read(absTgt);
	const before = headingsOf(originalTgt);
	if (before < 4) {
		info(P, relPath, `訳文の見出しが ${before} 件しかなく、まとめて消える状況を作れない`);
		return;
	}

	// 原文の先頭にコードブロックの閉じ忘れを入れる（以降が全部コードとして飲まれる）
	const lines = originalSrc.split("\n");
	const firstHeading = lines.findIndex((line) => /^#{1,6}\s/.test(line));
	lines.splice(firstHeading + 1, 0, "", "```text");
	fs.writeFileSync(absSrc, lines.join("\n"), "utf8");
	await sync();

	const afterBroken = headingsOf(read(absTgt));
	if (afterBroken >= before) ok(P, `フェンス崩れで訳文の本文が消えないOK（見出し ${before}→${afterBroken}）`);
	else fail(P, relPath, `フェンス崩れで訳文の本文が物理削除された（見出し ${before}→${afterBroken}）`, "");

	// 崩れを直すと確認待ちも自動で解ける
	fs.writeFileSync(absSrc, originalSrc, "utf8");
	await sync();
	const restored = read(absTgt);
	if (headingsOf(restored) >= before && !restored.includes("need:verify-deletion")) {
		ok(P, "崩れを直すと訳文が戻り verify-deletion も解けるOK");
	} else {
		fail(
			P,
			relPath,
			"崩れを直しても訳文が戻らない、または verify-deletion が残る",
			`headings=${headingsOf(restored)} (before=${before})`,
		);
	}

	fs.writeFileSync(absSrc, originalSrc, "utf8");
	fs.writeFileSync(absTgt, originalTgt, "utf8");

	// 小さい文書でも守られること。減り幅だけで境目を決めていたときは、見出し2つの README
	// （表題＋2節＝3ユニット）で訳文が2件とも物理削除されていた。崩れは文書の大きさに関係なく
	// 1ユニットまで潰すので、もとのユニット数で守られるかどうかが変わってはいけない。
	await checkSmallDocument(P);

	// 逆側の誤爆。原文がマーカーを失った状態で1章編集すると「対応が付いたのは1件」になるが、
	// 原文の構造は潰れていない。ここを崩れと読むと訳文に同じ章が2つ並ぶ。
	await checkMarkerlessSourceEdit(P);
}

/** 3ユニットの小さい文書を作り、フェンス崩れで訳文が消えないことを確かめる */
async function checkSmallDocument(P) {
	const smallSrc = path.join(contentDir(), "ja/_small_doc.md");
	const smallTgt = path.join(contentDir(), "en/_small_doc.md");
	const body = [
		"# 小さな手引き",
		"",
		"導入の文章。",
		"",
		"## 準備",
		"",
		"準備の本文。",
		"",
		"## 使い方",
		"",
		"使い方の本文。",
		"",
	].join("\n");
	try {
		fs.writeFileSync(smallSrc, body, "utf8");
		await sync();
		const before = headingsOf(read(smallTgt));
		if (before !== 3) {
			info(P, "content/ja/_small_doc.md", `訳文の見出しが ${before} 件で、想定した3ユニットの形になっていない`);
			return;
		}

		// 導入のすぐ後にフェンスの閉じ忘れを入れる（以降の2節が全部コードとして飲まれる）
		fs.writeFileSync(smallSrc, body.replace("導入の文章。", "導入の文章。\n\n```text"), "utf8");
		await sync();
		const after = headingsOf(read(smallTgt));
		if (after >= before) ok(P, `3ユニットの小さい文書でも訳文が消えないOK（見出し ${before}→${after}）`);
		else
			fail(
				P,
				"content/ja/_small_doc.md",
				`小さい文書でフェンス崩れが訳文を物理削除した（見出し ${before}→${after}）`,
				"",
			);

		fs.writeFileSync(smallSrc, body, "utf8");
		await sync();
		const restored = read(smallTgt);
		if (headingsOf(restored) >= before && !restored.includes("need:verify-deletion")) {
			ok(P, "小さい文書でも崩れを直すと訳文が戻り verify-deletion も解けるOK");
		} else {
			fail(
				P,
				"content/ja/_small_doc.md",
				"小さい文書で崩れを直しても戻らない、または verify-deletion が残る",
				restored.slice(0, 200),
			);
		}
	} finally {
		for (const file of [smallSrc, smallTgt]) if (fs.existsSync(file)) fs.rmSync(file);
	}
}

/**
 * マーカーを失った原文で1章だけ編集したとき、訳文に章が重複しないこと。
 *
 * 原文を控えや git から書き戻すとマーカーが落ちる。その状態で編集された章は
 * from の一致で結べず「孤立1件＋新規1件」になる。2ユニットの文書ではこれが
 * 「対応が付いたのは1件」に見えるため、対応の数で崩れを判定すると必ず誤爆する。
 */
async function checkMarkerlessSourceEdit(P) {
	const srcPath = path.join(contentDir(), "ja/_markerless.md");
	const tgtPath = path.join(contentDir(), "en/_markerless.md");
	const doc = (body) => ["# 手引き", "", "導入の本文。", "", "## 第1章", "", body, ""].join("\n");
	try {
		// 本文にマーカーが乗る運用へ戻す
		await switchConfig();
		fs.writeFileSync(srcPath, doc("第1章の本文。"), "utf8");
		await sync();
		const before = headingsOf(read(tgtPath));
		if (before !== 2) {
			info(P, "content/ja/_markerless.md", `訳文の見出しが ${before} 件で、想定した2ユニットの形になっていない`);
			return;
		}

		// マーカーを含まない本文で丸ごと差し替える（＝書き戻し＋1章の編集）
		fs.writeFileSync(srcPath, doc("第1章の本文（改訂）。"), "utf8");
		await sync();
		const after = read(tgtPath);
		if (headingsOf(after) === before && !after.includes("need:verify-deletion")) {
			ok(P, `マーカーを失った原文の編集で訳文が重複しないOK（見出し ${before}→${headingsOf(after)}）`);
		} else {
			fail(
				P,
				"content/ja/_markerless.md",
				`マーカーを失った原文の編集で訳文に章が重複した（見出し ${before}→${headingsOf(after)}）`,
				after.slice(0, 300),
			);
		}
	} finally {
		for (const file of [srcPath, tgtPath]) if (fs.existsSync(file)) fs.rmSync(file);
	}
}

// ===========================================================================
// P9 — 用語集（検出と展開）
// ===========================================================================

/*
 * 偽の AI（echo）は「訳文を1つ返す」形しか作れない。用語の検出も展開も答えは JSON の配列なので、
 * ここでは**用語が増えること自体は確かめられない**（実物の AI が要る）。増えないことを FAIL に
 * すると狼少年になるので INFO で控える。
 *
 * その代わり、AI を通さなくても決まる次の3つは FAIL として見る。
 *   ・用語の検出・展開は原稿（Markdown）を1文字も書き換えない
 *   ・展開は既にある用語集の行を失わない
 *   ・二度流しても用語集が変わらない（冪等）
 */
async function phase9() {
	const P = "P9-term";
	await resetWs();
	await sync();

	const srcFile = path.join(contentDir(), "ja/technical.md");
	const before = snapshot();
	const detected = await runCmd("mdait.term.detect", [srcFile]);
	if (detected.status === "error") {
		fail(P, "content/ja/technical.md", "term.detect が例外", String(detected.error));
	} else {
		const touched = changedFiles(before, snapshot());
		if (touched.length === 0) ok(P, "term.detect は原稿を書き換えないOK");
		else fail(P, touched[0], `term.detect が原稿を書き換えた（${touched.length}ファイル）`, touched.join(", "));

		const newTerms = detected.result?.newTerms ?? 0;
		if (newTerms > 0) ok(P, `term.detect が用語を ${newTerms} 件足した`);
		else info(P, "-", "偽の AI は用語の一覧（JSON 配列）を返せず、用語集が増えない（実物の AI で要確認）");
	}

	// 用語集を手で1行だけ用意する（訳語が空＝展開待ち）。検出では増やせないため、展開の入口をここで作る。
	const glossary = glossaryFile();
	const seeded = "ja,en,context,variants_ja\nマイクロサービスアーキテクチャ,,システム設計,\n";
	fs.writeFileSync(glossary, seeded, "utf8");

	const beforeExpand = snapshot();
	const expanded = await runCmd("mdait.term.expand", [path.join(contentDir(), "en")]);
	if (expanded.status === "error") {
		fail(P, "-", "term.expand が例外", String(expanded.error));
		return;
	}
	const touchedByExpand = changedFiles(beforeExpand, snapshot());
	if (touchedByExpand.length === 0) ok(P, "term.expand は原稿を書き換えないOK");
	else
		fail(
			P,
			touchedByExpand[0],
			`term.expand が原稿を書き換えた（${touchedByExpand.length}ファイル）`,
			touchedByExpand.join(", "),
		);

	const afterExpand = readIfExists(glossary);
	if (afterExpand.includes("マイクロサービスアーキテクチャ")) ok(P, "term.expand が既にある用語集の行を残すOK");
	else fail(P, path.basename(glossary), "term.expand の後に用語集の行が消えた", afterExpand.slice(0, 200));

	const expandMessage = dialogMessages(expanded).find((message) => message.includes("Term expansion completed"));
	if (/([1-9]\d*) term\(s\) expanded/.test(expandMessage ?? "")) {
		ok(P, `term.expand が訳語を埋めた（${expandMessage}）`);
	} else {
		info(P, "-", "偽の AI は訳語の一覧（JSON 配列）を返せず、用語の展開が0件になる（実物の AI で要確認）");
	}

	// 二度目。用語が増えないのは同じでも、書き出しが揺れていないかはここで分かる
	await runCmd("mdait.term.expand", [path.join(contentDir(), "en")]);
	if (readIfExists(glossary) === afterExpand) ok(P, "term.expand 2回目で用語集が変わらないOK（冪等）");
	else fail(P, path.basename(glossary), "term.expand を2回流すと用語集が変わる（非冪等）", "byte diff");

	// フォルダ専用のコマンドにファイルを渡したとき（案内を出して何もしないのが正）
	const beforeFileArg = readIfExists(glossary);
	const byFile = await runCmd("mdait.term.expand", [srcFile]);
	if (byFile.status !== "error" && readIfExists(glossary) === beforeFileArg) {
		ok(P, "ファイルを渡した term.expand は何もせず用語集も触らないOK（フォルダ専用）");
	} else {
		fail(P, path.basename(glossary), "ファイルを渡した term.expand が用語集を書き換えた", String(byFile.error ?? ""));
	}
}

// ===========================================================================
// P10 — 翻訳メモリへの登録
// ===========================================================================

/*
 * 登録の可否は「from があって need が付いていない」だけで決まる（commit-filter）。ここは AI を
 * 通らないので FAIL として見る。実際に文の対を作るところは AI の答え（JSON の配列）が要るため、
 * 偽の AI では必ず0件になる。それは INFO で控える。
 */
async function phase10() {
	const P = "P10-tm";
	await resetWs();
	await sync();

	const rel = "content/en/technical.md";
	const abs = path.join(ws, rel);
	if (!fs.existsSync(abs)) {
		info(P, rel, "対象ファイルが見つからず、TM 登録を確かめられない");
		return;
	}

	// ---- (a) 訳す前。確定した対訳が無いので1件も拾わないはず ----
	const beforeTrans = await runCmd("mdait.tm.commit.file", [abs]);
	const beforeValue = beforeTrans.result;
	if (!beforeValue) {
		info(P, rel, `tm.commit が結果を返さなかった（TM が無効かもしれない）: ${String(beforeTrans.error ?? "")}`);
		return;
	}
	const pendingUnits = markerInfo(read(abs)).filter((marker) => marker.need.startsWith("translate")).length;
	if (beforeValue.processedUnits === 0 && beforeValue.skipReasons?.needTranslate === pendingUnits) {
		ok(P, `翻訳前の tm.commit は1件も拾わないOK（見送り needTranslate=${pendingUnits}）`);
	} else {
		fail(
			P,
			rel,
			`翻訳前なのに tm.commit が対象を拾った（processed=${beforeValue.processedUnits}, needTranslate=${beforeValue.skipReasons?.needTranslate} / 期待 0, ${pendingUnits}）`,
			JSON.stringify(beforeValue.skipReasons ?? {}),
		);
	}

	// ---- (b) 訳した後。マーカーの姿から数えた「確定した対訳」と一致するはず ----
	const translated = await trans(abs);
	if (translated.status === "error") {
		fail(P, rel, "trans が例外（TM 登録の前提が作れない）", String(translated.error));
		return;
	}
	const markers = markerInfo(read(abs));
	const settled = markers.filter((marker) => marker.from !== "" && marker.need === "").length;
	const afterTrans = await runCmd("mdait.tm.commit.file", [abs]);
	const afterValue = afterTrans.result ?? {};
	if (afterValue.processedUnits === settled && (afterValue.skipReasons?.needTranslate ?? 0) === 0) {
		ok(P, `翻訳後の tm.commit が確定した対訳だけを拾うOK（${settled}件 / 見送り ${afterValue.skippedUnits}件）`);
	} else {
		fail(
			P,
			rel,
			`tm.commit の対象がマーカーの姿と合わない（processed=${afterValue.processedUnits} / 期待 ${settled}）`,
			JSON.stringify(afterValue.skipReasons ?? {}),
		);
	}

	if ((afterValue.newEntries ?? 0) > 0) ok(P, `TM へ ${afterValue.newEntries} 件登録`);
	else info(P, "-", "偽の AI は文の対（JSON 配列）を返せず、TM が1件も増えない（実物の AI で要確認）");

	// ---- (c) 二度流しても翻訳メモリが変わらない ----
	const tmxOnce = readIfExists(tmxFile());
	await runCmd("mdait.tm.commit.file", [abs]);
	if (readIfExists(tmxFile()) === tmxOnce) ok(P, "tm.commit 2回目で translations.tmx が変わらないOK（冪等）");
	else fail(P, "translations.tmx", "tm.commit を2回流すと翻訳メモリが変わる（非冪等）", "byte diff");

	// ---- (d) フォルダ単位でも原稿を書き換えない ----
	const beforeDir = snapshot();
	const dirResult = await runCmd("mdait.tm.commit.directory", [path.join(contentDir(), "en/child")]);
	if (dirResult.status === "error") {
		fail(P, "content/en/child", "tm.commit.directory が例外", String(dirResult.error));
	} else {
		const touched = changedFiles(beforeDir, snapshot());
		if (touched.length === 0) ok(P, "tm.commit.directory は原稿を書き換えないOK");
		else fail(P, touched[0], `tm.commit.directory が原稿を書き換えた（${touched.length}ファイル）`, touched.join(", "));
	}
}

// ===========================================================================
// P11 — 訳文のレビュー
// ===========================================================================

/*
 * レビューは最初に「未確認だけを見るか、全部を見るか」を選ばせる（QuickPick）。画面の無い
 * headless では誰も答えられないので、レビュー本体（AI との照合・need:review の付け外し）は走らない。
 * それでも「呼んでも訳文が書き換わらない」ことだけは確かめられる。走らなかったことは INFO で控える。
 */
async function phase11() {
	const P = "P11-aireview";
	await resetWs();
	await sync();

	const rel = "content/en/technical.md";
	const abs = path.join(ws, rel);
	const translated = await trans(abs);
	if (translated.status === "error") {
		fail(P, rel, "trans が例外（レビューの前提が作れない）", String(translated.error));
		return;
	}

	const before = snapshot();
	const fileReview = await runCmd("mdait.aiReview.file", [abs]);
	if (fileReview.status === "error") {
		fail(P, rel, "aiReview.file が例外", String(fileReview.error));
	} else {
		const touched = changedFiles(before, snapshot());
		if (touched.length === 0) ok(P, "aiReview.file は訳文を書き換えないOK");
		else fail(P, touched[0], `aiReview.file が訳文を書き換えた（${touched.length}ファイル）`, touched.join(", "));
	}

	const beforeDir = snapshot();
	const dirReview = await runCmd("mdait.aiReview.directory", [path.join(contentDir(), "en/child")]);
	if (dirReview.status === "error") {
		fail(P, "content/en/child", "aiReview.directory が例外", String(dirReview.error));
	} else {
		const touched = changedFiles(beforeDir, snapshot());
		if (touched.length === 0) ok(P, "aiReview.directory は訳文を書き換えないOK");
		else fail(P, touched[0], `aiReview.directory が訳文を書き換えた（${touched.length}ファイル）`, touched.join(", "));
	}

	// レビューが走ったなら、ファイル1件ぶんの結果（配列）が返る。返らないのは範囲の選択で止まったとき
	if (Array.isArray(fileReview.result)) {
		ok(P, `aiReview.file が結果を返した（${JSON.stringify(fileReview.result).slice(0, 120)}）`);
	} else {
		info(
			P,
			"-",
			"レビューの範囲を選ぶ QuickPick に headless では答えられず、レビュー本体（AI 照合・need:review の付け外し）は走らない",
		);
	}
}

// ===========================================================================
// P12 — 既にある訳の取り込み（adopt）
// ===========================================================================

/*
 * いちばん怖いのは「取り込んだつもりが、既にある訳を消す・上書きする」こと。だからここは
 * 本文の一致（マーカーの行を除いた中身が1文字も変わらないこと）を軸に見る。取り込みは
 * 位置で対応づけるだけで AI を使わないので（align を明示したときだけ AI）、全部 FAIL として見てよい。
 *
 * 引数は**オブジェクトのまま**渡す。`lab run mdait.sync '{"adopt":true}'` のように文字列で渡すと
 * 文字列のまま届き、取り込みが起きないまま普通の sync として終わる（実測）。
 */
async function phase12() {
	const P = "P12-adopt";
	await resetWs();

	const rel = "content/en/40_structure_mismatch.md";
	const abs = path.join(ws, rel);
	if (!fs.existsSync(abs)) {
		info(P, rel, "マーカー無しの既存対訳の見本が無く、取り込みを確かめられない");
		return;
	}
	const originalBody = read(abs);

	const adopted = await runCmd("mdait.sync", [{ adopt: true }]);
	if (adopted.status === "error") {
		fail(P, "-", "adopt 付きの sync が失敗した", String(adopted.error));
		return;
	}
	const value = adopted.result ?? {};
	if ((value.totalAdopted ?? 0) > 0) ok(P, `既存訳を ${value.totalAdopted} ユニット取り込んだOK`);
	else fail(P, "-", "adopt を指定したのに1ユニットも取り込まれない", JSON.stringify(value));

	if (bodyWithoutMarkers(read(abs)) === originalBody) ok(P, "取り込んでも既存訳の本文が1文字も変わらないOK");
	else fail(P, rel, "取り込みで既存訳の本文が変わった", "マーカー行を除いた中身に差分あり");

	const adoptedMarkers = markerInfo(read(abs));
	const reviewed = adoptedMarkers.filter((marker) => marker.from !== "" && marker.need === "review").length;
	if (adoptedMarkers.length > 0 && reviewed === adoptedMarkers.length) {
		ok(P, `取り込んだユニットに from と need:review が付くOK（${reviewed}件）`);
	} else {
		fail(
			P,
			rel,
			`取り込み後のマーカーが from＋need:review になっていない（${reviewed}/${adoptedMarkers.length}）`,
			adoptedMarkers.map((marker) => `${marker.hash}/${marker.from}/${marker.need}`).join(" | "),
		);
	}

	// 取り込んだ訳を、あとから翻訳が上書きしないこと（need:review は翻訳の対象ではない）
	const transResult = await trans(abs);
	const transValue = transResult.result ?? {};
	if ((transValue.translatedCount ?? 0) === 0 && bodyWithoutMarkers(read(abs)) === originalBody) {
		ok(P, "取り込んだ訳は trans に上書きされないOK（確認待ちは翻訳の対象外）");
	} else {
		fail(
			P,
			rel,
			`取り込んだ訳が trans で書き換えられた（translated=${transValue.translatedCount}）`,
			JSON.stringify(transValue),
		);
	}

	// 確認待ち（need:review）は確定した対訳ではないので TM にも登録されない
	const committed = await runCmd("mdait.tm.commit.file", [abs]);
	const commitValue = committed.result;
	if (commitValue && commitValue.processedUnits === 0 && (commitValue.skipReasons?.needReview ?? 0) > 0) {
		ok(P, `確認待ちの訳は TM へ登録されないOK（見送り needReview=${commitValue.skipReasons.needReview}）`);
	} else if (!commitValue) {
		info(P, rel, "tm.commit が結果を返さず、確認待ちの見送りを確かめられない");
	} else {
		fail(
			P,
			rel,
			`確認待ちの訳が TM へ登録された（processed=${commitValue.processedUnits}）`,
			JSON.stringify(commitValue.skipReasons ?? {}),
		);
	}

	// 取り込みのあと、普通の sync が落ち着いているか
	const settled = await sync();
	if (
		settled.totalAdded === 0 &&
		settled.totalModified === 0 &&
		settled.totalDeleted === 0 &&
		settled.revisionsNeeded === 0
	) {
		ok(P, "取り込み後の sync が落ち着いているOK（added/modified/deleted/revise すべて0）");
	} else {
		fail(P, "-", "取り込み後の sync が落ち着かない", JSON.stringify(settled));
	}
	const afterFirst = read(abs);
	await sync();
	if (read(abs) === afterFirst) ok(P, "取り込み後 sync を重ねても訳文が変わらないOK（冪等）");
	else fail(P, rel, "取り込み後の sync が非冪等（訳文が変わる）", "byte diff");

	// 訳文だけにある章（原文に対応が無い章）は、消さずに一次受けする。
	// 見本は content/en/50_target_extra.md の "Availability in your region"（原文に無い章）。
	const extraRel = "content/en/50_target_extra.md";
	const extraAbs = path.join(ws, extraRel);
	if ((value.totalOrphanReviewed ?? 0) > 0) {
		ok(P, `訳文だけにある章を消さずに一次受けするOK（${value.totalOrphanReviewed}件）`);
	} else {
		fail(P, extraRel, "訳文だけにある章の一次受け（totalOrphanReviewed）が働かない", JSON.stringify(value));
	}
	if (fs.existsSync(extraAbs)) {
		const extraBody = read(extraAbs);
		if (extraBody.includes("Availability in your region")) {
			ok(P, "原文に無い章が取り込みで消えないOK");
		} else {
			fail(P, extraRel, "原文に無い章が取り込みで消えた", extraBody.slice(0, 300));
		}
	}

	// ---- frontmatter の既訳も取り込むこと（人の書いたタイトルを機械翻訳で上書きしない） ----
	const fmRel = "content/en/20_no_marker.md";
	const fmAbs = path.join(ws, fmRel);
	if (fs.existsSync(fmAbs)) {
		const front = /front:\s*'([^']*)'/.exec(read(fmAbs))?.[1] ?? "";
		if (/need:review/.test(front)) {
			ok(P, "訳された frontmatter が確認待ちで取り込まれるOK（翻訳待ちにしない）");
		} else {
			fail(P, fmRel, "訳された frontmatter が取り込まれていない（trans に上書きされる）", front || "front マーカー無し");
		}
		const transFront = await runCmd("mdait.translate.frontmatter", [fmAbs]);
		if (transFront.status !== "error" && read(fmAbs).includes("English Test 2")) {
			ok(P, "確認待ちの frontmatter は trans に上書きされないOK");
		} else {
			fail(P, fmRel, "確認待ちの frontmatter が翻訳で書き換えられた", read(fmAbs).slice(0, 200));
		}
	} else {
		info(P, fmRel, "frontmatter を持つマーカー無しの既訳の見本が無い");
	}

	// ---- 取り込み → 今回の改訂 → レビュー完了（既訳が消えないこと。ADR-260901-01） ----
	//
	// かつてここで既訳の英文がまるごと消えた。確認待ちのあいだ訳文の from だけを止めていたため、
	// 原文側の hash が進んだ瞬間に紐が切れ、レビューを終えた次の sync で「原文が消えた孤立」と
	// 見なされて削除されていた（同じ位置に日本語の原文が need:translate で置き直された）。
	const srcRel = "content/ja/40_structure_mismatch.md";
	const srcAbs = path.join(ws, srcRel);
	const beforeRevision = bodyWithoutMarkers(read(abs));
	const marker = "改訂で足した一文。";
	fs.writeFileSync(srcAbs, read(srcAbs).replace("インストール手順を説明します。", `インストール手順を説明します。${marker}`), "utf8");
	await reload();

	const revised = await sync();
	if (bodyWithoutMarkers(read(abs)) === beforeRevision && (revised.totalDeleted ?? 0) === 0) {
		ok(P, "確認待ちのまま原文を改訂しても既訳の本文が変わらないOK");
	} else {
		fail(
			P,
			rel,
			`確認待ちのまま原文を改訂したら訳文が変わった（deleted=${revised.totalDeleted}）`,
			JSON.stringify(revised),
		);
	}
	if ((revised.revisionsNeeded ?? 0) >= 1 && (revised.totalReviewsSuperseded ?? 0) >= 1) {
		ok(P, `確認待ちから改訂待ちへ移り、件数が結果に出るOK（${revised.totalReviewsSuperseded}件）`);
	} else {
		fail(
			P,
			rel,
			`改訂待ちへ移らない、または件数が伝わらない（revise=${revised.revisionsNeeded} / superseded=${revised.totalReviewsSuperseded}）`,
			JSON.stringify(revised),
		);
	}

	// 人が「レビュー済み」を押す（CodeLens・ツリー・LM Tool と同じ入口を直に叩く）
	await inprocReload();
	const { getFileHandler } = out("commands/file-handler/file-handler-factory.js");
	const resolved = await getFileHandler(abs).resolveNeed(abs, { needs: ["review"] });
	await reload();
	const afterReview = await sync();
	const bodyAfterReview = bodyWithoutMarkers(read(abs));
	if (bodyAfterReview === beforeRevision && (afterReview.totalDeleted ?? 0) === 0 && !bodyAfterReview.includes(marker)) {
		ok(P, `レビュー完了のあとも既訳が残るOK（解決 ${resolved.resolved.length}件・削除0）`);
	} else {
		fail(
			P,
			rel,
			`レビュー完了で既訳が消えた（deleted=${afterReview.totalDeleted} / 原文の混入=${bodyAfterReview.includes(marker)}）`,
			JSON.stringify(afterReview),
		);
	}
}

// ===========================================================================
// P13 — 端の原稿
// ===========================================================================

/*
 * 端の原稿は「壊れ方が静か」なのが怖い。空マーカー・コードブロックの中の見本・空ファイル・
 * frontmatter だけの原稿は、どれも見た目には何も起きないので、気づかないまま壊れる。
 * ここは AI を通らない（frontmatter の翻訳だけ通るが、見るのはマーカーと本文の姿）。
 */
async function phase13() {
	const P = "P13-edge";
	await resetWs();
	await sync();

	// ---- 空マーカー（`<!-- mdait -->`）にハッシュが埋まる ----
	const hashRel = "content/ja/hash-empty-marker-test.md";
	const hashAbs = path.join(ws, hashRel);
	if (fs.existsSync(hashAbs)) {
		const markers = markerInfo(read(hashAbs));
		const empty = markers.filter((marker) => marker.hash === "").length;
		if (markers.length > 0 && empty === 0) ok(P, `空マーカーにハッシュが埋まるOK（${markers.length}件すべて8桁hex）`);
		else fail(P, hashRel, `sync 後もハッシュの無いマーカーが ${empty} 件残る`, "");
	} else {
		info(P, hashRel, "空マーカーの見本が無く、ハッシュの補完を確かめられない");
	}

	// ---- コードブロックの中の「マーカーの書き方の見本」は書き換えない ----
	const codeRel = "content/ja/code-block-marker.md";
	const codeAbs = path.join(ws, codeRel);
	if (fs.existsSync(codeAbs)) {
		const body = read(codeAbs);
		const samples = ["<!-- mdait 12345678 from:87654321 need:translate -->", "<!-- mdait aabbccdd -->"];
		const lost = samples.filter((sample) => !body.includes(sample));
		if (lost.length === 0) ok(P, "コードブロックの中のマーカーの見本が書き換わらないOK");
		else fail(P, codeRel, `コードブロックの中の見本が書き換えられた（${lost.length}件）`, lost.join(" / "));
	} else {
		info(P, codeRel, "コードブロック内マーカーの見本が無く、誤マッチを確かめられない");
	}

	// ---- 空の原稿 ----
	const emptyRel = "content/ja/child/child2/empty.md";
	const emptyAbs = path.join(ws, emptyRel);
	if (fs.existsSync(emptyAbs)) {
		const body = read(emptyAbs);
		if (body.trim() === "") ok(P, "空の原稿にマーカーが書き込まれないOK");
		else fail(P, emptyRel, "空の原稿に何かが書き込まれた", body.slice(0, 120));
		const emptyTarget = path.join(ws, emptyRel.replace("/ja/", "/en/"));
		if (fs.existsSync(emptyTarget))
			info(P, emptyRel, "空の原稿から訳文ファイルが作られた（中身の無いファイルが増える）");
	} else {
		info(P, emptyRel, "空の原稿の見本が無い");
	}

	// ---- frontmatter だけの原稿 ----
	const frontRel = "content/en/only-frontmatter.md";
	const frontAbs = path.join(ws, frontRel);
	if (fs.existsSync(frontAbs)) {
		const before = read(frontAbs);
		if (markerLines(before).length === 0 && before.includes("front:")) {
			ok(P, "frontmatter だけの原稿は本文にマーカーを持たないOK（front マーカーだけ）");
		} else {
			fail(P, frontRel, "frontmatter だけの原稿の姿がおかしい", before.slice(0, 200));
		}
		const result = await runCmd("mdait.translate.frontmatter", [frontAbs]);
		if (result.status === "error") {
			fail(P, frontRel, "translate.frontmatter が例外", String(result.error));
		} else {
			const after = read(frontAbs);
			const needLeft = /front:\s*'[^']*need:/.test(after);
			if (!needLeft && after.includes("weight: 20")) {
				ok(P, "frontmatter を訳すと need が消え、翻訳の対象でないキーが残るOK");
			} else {
				fail(P, frontRel, `frontmatter の翻訳後の姿がおかしい（need 残り=${needLeft}）`, after.slice(0, 200));
			}
		}
	} else {
		info(P, frontRel, "frontmatter だけの見本が無い");
	}

	// ---- Windows で書かれた（CRLF の）原稿を書き換えない ----
	// `.gitattributes` が eol=lf なので、見本は置けない。ここで CRLF に直してから確かめる
	const crlfRel = "content/en/10_test.md";
	const crlfAbs = path.join(ws, crlfRel);
	const crlfSrcAbs = path.join(ws, "content/ja/10_test.md");
	if (fs.existsSync(crlfAbs) && fs.existsSync(crlfSrcAbs)) {
		for (const target of [crlfAbs, crlfSrcAbs]) {
			fs.writeFileSync(target, read(target).replace(/\r?\n/g, "\r\n"), "utf8");
		}
		const beforeCrlf = read(crlfAbs);
		await reload();
		await sync();
		const afterCrlf = read(crlfAbs);
		const lfOnly = /[^\r]\n/.test(afterCrlf);
		if (afterCrlf === beforeCrlf) {
			ok(P, "CRLF の訳文が sync で書き換わらないOK（1バイトも変わらない）");
		} else if (!lfOnly) {
			ok(P, "CRLF の訳文が CRLF のまま保たれるOK（マーカーの更新はある）");
		} else {
			fail(P, crlfRel, "CRLF の原稿が LF に書き換えられた", `LF だけの行が混ざっている（${afterCrlf.length}文字）`);
		}
		if (/[^\r]\n/.test(read(crlfSrcAbs))) {
			fail(P, "content/ja/10_test.md", "原文の CRLF が LF に書き換えられた", "");
		} else {
			ok(P, "原文の CRLF も保たれるOK");
		}
	} else {
		info(P, crlfRel, "CRLF に直せる見本が無い");
	}

	// ---- マーカー無しの既訳は、普通の sync では確定扱いにしない ----
	const noMarkerRel = "content/en/20_no_marker.md";
	const noMarkerAbs = path.join(ws, noMarkerRel);
	if (fs.existsSync(noMarkerAbs)) {
		const markers = markerInfo(read(noMarkerAbs));
		const settled = markers.filter((marker) => marker.from !== "" && marker.need === "").length;
		if (markers.length > 0 && settled === 0) {
			ok(P, "マーカー無しの既訳を普通の sync が勝手に確定させないOK（取り込みは adopt だけ）");
		} else {
			fail(
				P,
				noMarkerRel,
				`マーカー無しの既訳が確定した対訳として扱われた（${settled}/${markers.length}）`,
				markers.map((marker) => `${marker.hash}/${marker.from}/${marker.need}`).join(" | "),
			);
		}
	} else {
		info(P, noMarkerRel, "マーカー無しの既訳の見本が無い");
	}
}

// ===========================================================================
// P14 — 見出しレベルの境目
// ===========================================================================

/*
 * ユニットの境目は見出しの深さ（sync.level）で決まる。浅くすれば章はまとまり、深くすれば分かれる。
 * ここで見たいのは「設定どおりの深さで切れるか」と「深さを変えても本文が失われないか」の2つ。
 * どちらも AI を通らないので FAIL として見る。
 */
async function phase14() {
	const P = "P14-level";
	// 見出しレベル2（H1・H2 だけを境目にする）で作り直す
	await resetWs({ level: 2 });
	const before = snapshot();
	await sync();
	const after = snapshot();

	const rel = "content/ja/technical.md";
	const abs = path.join(ws, rel);
	if (!fs.existsSync(abs)) {
		info(P, rel, "見出しの深い原稿が無く、レベルの境目を確かめられない");
		return;
	}
	const levels = headingLevels(read(abs));
	const shallow = levels.filter((level) => level <= 2).length;
	const markers = markerLines(read(abs)).length;
	if (levels.length > shallow && markers === shallow) {
		ok(P, `レベル2の境目が H1・H2 だけになるOK（マーカー ${markers}件 / 見出し ${levels.length}件）`);
	} else {
		fail(
			P,
			rel,
			`レベル2なのに境目の数が合わない（マーカー ${markers}件 / H1・H2 ${shallow}件 / 見出し合計 ${levels.length}件）`,
			"",
		);
	}

	// 深さを変えても本文（見出し）が減らないこと
	let lost = 0;
	for (const [relPath, content] of Object.entries(after)) {
		if (!relPath.endsWith(".md")) continue;
		const was = before[relPath];
		if (was === undefined) continue;
		if (headingLevels(content).length < headingLevels(was).length) {
			lost += 1;
			fail(P, relPath, "レベル2の sync で見出しが減った（本文の喪失）", "");
		}
	}
	if (lost === 0) ok(P, "レベル2の sync で見出しが1つも減らないOK");

	const once = snapshot();
	const second = await sync();
	if (JSON.stringify(once) === JSON.stringify(snapshot()) && second.totalAdded === 0 && second.totalModified === 0) {
		ok(P, "レベル2の sync が冪等OK（2回目で無変化）");
	} else {
		fail(P, "-", `レベル2の sync が非冪等 (added=${second.totalAdded}, modified=${second.totalModified})`, "");
	}

	// 深さを戻す。既にある境目は動かないので、本文が増えたり消えたりしてはいけない
	await switchConfig();
	await sync();
	const backHeadings = headingLevels(read(abs)).length;
	if (backHeadings === levels.length) ok(P, `レベルを戻しても見出しの数が変わらないOK（${backHeadings}件）`);
	else fail(P, rel, `レベルを戻したら見出しの数が変わった（${levels.length}→${backHeadings}）`, "");

	const afterBack = snapshot();
	await sync();
	if (JSON.stringify(afterBack) === JSON.stringify(snapshot())) ok(P, "レベルを戻した後の sync も冪等OK");
	else fail(P, "-", "レベルを戻した後の sync が非冪等", "");
}

// ===========================================================================
// 段の一覧と入口
// ===========================================================================

const PHASES = [
	["P1-sync", phase1],
	["P2-trans", phase2],
	["P3-revise", phase3],
	["P4-nonmd", phase4],
	["P5-external", phase5],
	["P6-modeswitch", phase6],
	["P7-nosilentdelete", phase7],
	["P8-nobodyloss", phase8],
	["P9-term", phase9],
	["P10-tm", phase10],
	["P11-aireview", phase11],
	["P12-adopt", phase12],
	["P13-edge", phase13],
	["P14-level", phase14],
];

/** --only の書き方（P1 / P1-sync / 1 のどれでも）を段の名前へ直す */
function selectPhases(only) {
	if (!only) return PHASES;
	const wanted = String(only)
		.split(/[,\s]+/)
		.filter(Boolean)
		.map((token) => token.replace(/^p/i, "P").toLowerCase());
	return PHASES.filter(([name]) => {
		const key = name.toLowerCase();
		const number = key.slice(1, key.indexOf("-"));
		return wanted.some((w) => key === w || key.startsWith(`${w}-`) || w === number || w === `p${number}`);
	});
}

/**
 * スイープを1回まわす。
 *
 * 実験場（`lab up`）は既に立っている前提。作業場は最初に見本から作り直すので、
 * どんな状態から呼ばれても同じところから始まる。
 *
 * @param {{session?: object, verbose?: boolean, only?: string}} options
 * @returns {Promise<{findings: Array<object>, failed: number}>}
 */
export async function run(options = {}) {
	const session = options.session ?? readSession();
	if (!session?.ws) throw new Error("実験場が立っていません。先に `lab up` を実行してください");
	if (session.host !== "headless") {
		say(`※ ホストが ${session.host} です。スイープは headless を前提に作ってあります。`);
	}
	ws = session.ws;
	wsMode = session.wsMode ?? "tmp";
	runDir = session.runDir ?? null;
	aiInfo = session.ai ?? null;
	verbose = Boolean(options.verbose);
	findings = [];

	if (!aiInfo?.baseURL) {
		say("※ AI の相手が立っていません。P2・P3・P4 の翻訳は失敗します（`lab up --ai echo` で始めてください）。");
	}

	say(`========== 決まった手順のスイープ（作業場 ${ws}） ==========`);
	const phases = selectPhases(options.only);
	// 最初の段は作業場が手つかずであることを前提にしている（P1 は初回の sync を見る）
	await resetWs();
	for (const [name, phase] of phases) {
		const from = findings.length;
		try {
			await phase();
		} catch (error) {
			fail(name, "-", "段の途中で止まった", String(error?.stack ?? error));
		}
		const tally = tallyOf(name, from);
		say(`${name}: OK ${tally.ok} / INFO ${tally.info} / FAIL ${tally.fail}`);
	}

	const failed = findings.filter((f) => f.sev === "FAIL");
	const infos = findings.filter((f) => f.sev === "INFO");
	say("");
	say("========== まとめ ==========");
	say(`FAIL=${failed.length} INFO=${infos.length} OK=${findings.filter((f) => f.sev === "OK").length}`);
	for (const finding of infos) say(`  INFO (${finding.phase}) ${finding.file}: ${finding.summary}`);
	for (const finding of failed) {
		say(`  FAIL (${finding.phase}) ${finding.file}: ${finding.summary}`);
		if (finding.detail) say(`         ${String(finding.detail).split("\n").join("\n         ")}`);
	}
	if (runDir) say(`手順の全文: ${runDir}/steps`);
	return { findings, failed: failed.length };
}

// ===========================================================================
// 単独で動かすとき
// ===========================================================================

function alive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** lab.mjs を子として動かす */
function runLab(argv) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [LAB, ...argv], {
			stdio: "inherit",
			env: { ...process.env, MDAIT_LAB_DIR: LAB_DIR },
		});
		child.on("exit", (code) =>
			code === 0 || code === null
				? resolve(0)
				: reject(new Error(`lab ${argv[0]} が失敗しました（終了コード ${code}）`)),
		);
	});
}

async function main() {
	const opts = parseArgs(process.argv.slice(2), { booleans: ["verbose", "keep", "help"] });
	if (opts.help) {
		say("使い方: node scripts/lab/scenarios/sweep.mjs [--verbose] [--only P1,P5] [--keep]");
		return 0;
	}
	let session = readSession();
	let startedHere = false;
	if (!session?.hostPid || !alive(session.hostPid)) {
		say("実験場が立っていないので、既定（headless + echo + 使い捨ての作業場）で始めます。");
		await runLab(["up", "--host", "headless", "--ai", "echo", "--ws", "tmp", "--reset", "--name", "sweep"]);
		session = readSession();
		startedHere = true;
	}
	const { failed } = await run({ session, verbose: Boolean(opts.verbose), only: opts.only });
	if (startedHere && !opts.keep) await runLab(["down"]);
	return failed > 0 ? 1 : 0;
}

// 直に動かしたときだけ入口を開く。
// out/ を読み込むと見張りやタイマーが残り、待っていてもこのプロセスは終わらないので必ず自分で閉じる。
const invokedDirectly = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
	main()
		.then((code) => process.exit(code))
		.catch((error) => {
			process.stderr.write(`${error?.stack ?? error}\n`);
			process.exit(1);
		});
}
