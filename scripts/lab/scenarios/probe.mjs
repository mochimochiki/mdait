#!/usr/bin/env node
/*
 * 頑健性プローブ（調査用・CI 非対象）。旧 scripts/exploratory/probe-robustness.js の移設版。
 *
 * 何をする道具か
 * --------------
 * 「原文を編集する」「章を入れ替える」「ファイルの名前を変える」「フォルダごと動かす」
 * ……といった**人がふつうにやる操作**を1つずつ起こし、そのあと sync を回して、
 * 原文と訳文の対応づけがどうなったかをそのまま書き出す。
 *
 * 同じ手順を **マーカーの置き場が2通り（本文に埋め込む embedded ／ 外に持つ external）**
 * のそれぞれで流し、最後に結果を並べて突き合わせる。これがこの道具の本質で、
 * 「どちらが正しいか」は決めない。両者の性質は正反対で、正しさが一つに決まらないためである。
 *
 * 出るもの（3つ）
 *   1. シナリオごとの観察結果（ファイル一覧・各ユニットの need/hash/from・unit-state）
 *   2. 両モードの突き合わせ（一致／想定内の差／想定外の差）
 *   3. 絶対チェック（両モードが**揃って**壊れると突き合わせでは出ないので、結果そのものを見る）
 *
 * 読み方は docs/design/unit-state.md を参照。
 *
 * 使い方
 * ------
 *   node scripts/lab/lab.mjs probe                  （まとめ役から呼ばれる形）
 *   node scripts/lab/scenarios/probe.mjs            （単独で動かす）
 *   node scripts/lab/scenarios/probe.mjs --only S3,S13
 *   node scripts/lab/scenarios/probe.mjs --time     （下ごしらえの所要時間を出す）
 *   node scripts/lab/scenarios/probe.mjs --keep     （終わっても作業場を作り直さない）
 *   node scripts/lab/scenarios/probe.mjs --diff <前の run のパス>
 *
 * 前回との差分について
 * --------------------
 * 観察結果は run ディレクトリの `probe-observations.json` に残す。次に走らせると
 * 直前の run の同じファイルと突き合わせ、「前回と何が変わったか」を出す。旧実装に無かった
 * 能力で、製品を直したあとに**どのシナリオが動いたか**をひと目で見るためのもの。
 *
 * 手順の動かし方
 * --------------
 * sync と trans は土台（lib/ipc.mjs の sendCommand）を通して headless ホストに頼む。
 * 原稿の編集・章の並べ替え・リネーム・フォルダ移動・削除・設定の書き換えは、
 * 土台が持っていない操作なのでこのファイルが直接ディスクを触る。
 *
 * ただし次の3つだけは、ホストの「頭の中」を触る操作でファイル経由では頼めないため、
 * このプロセスで out/ の実装を直に呼ぶ（呼んだあとは必ず `lab.reload` でホストに
 * ディスクから読み直させ、覚えたままの中身とディスクが食い違わないようにする）:
 *
 *   - 対象言語の選び直し（SelectionState）  … S62 / S63 / S86
 *   - 保存時の単ファイル同期（syncSingleFile）… S87
 *   - エディタ上の移動の再現（rename-follow）… S7 / S8 / S10 / S28 / S76 / S77 / S78
 *
 * これらを IPC から叩けるようになれば（`lab.select` / `mdait.sync.file` / `lab.rename` 相当）、
 * このファイルから out/ の読み込みを丸ごと落とせる。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "../lib/args.mjs";
import { ipcPaths, sendCommand } from "../lib/ipc.mjs";
import { RUNS_DIR } from "../lib/runs.mjs";
import { LAB_DIR, readSession } from "../lib/session.mjs";
import { REPO, configureAi, prepareWorkspace } from "../lib/workspace.mjs";

const LAB_CLI = path.join(REPO, "scripts", "lab", "lab.mjs");
/** 観察結果の置き場の名前（run ディレクトリの直下） */
const OBSERVATIONS = "probe-observations.json";
/**
 * 絞って走らせたときの置き場。全件の控えを潰さないために名前を分ける。
 * （潰すと、次に全件を走らせたときに 150 件以上が「追加」に見えて差分が読めなくなる）
 */
const OBSERVATIONS_PARTIAL = "probe-observations-partial.json";

/**
 * 過去の run から、同じ走らせ方の控えを新しい順に1つ探す。
 * 見つからなければ null（最初の1回目）。
 */
function latestObservationsBefore(currentRunDir, only) {
	const wanted = only ? OBSERVATIONS_PARTIAL : OBSERVATIONS;
	const runsRoot = path.dirname(currentRunDir);
	let entries;
	try {
		entries = fs.readdirSync(runsRoot, { withFileTypes: true });
	} catch {
		return null;
	}
	const candidates = entries
		.filter((e) => e.isDirectory() && path.join(runsRoot, e.name) !== currentRunDir)
		.map((e) => path.join(runsRoot, e.name, wanted))
		.filter((file) => fs.existsSync(file))
		.sort();
	return candidates.length > 0 ? candidates[candidates.length - 1] : null;
}

// ===========================================================================
// この実行のあいだ持ち回るもの
// ===========================================================================

/** 作業場（ワークスペース）の絶対パス */
let WS = "";
/** 原稿の置き場 */
let CONTENT = "";
/** .mdait の置き場 */
let MDAIT = "";
/** 設定ファイル */
let CFG = "";
/** 記録の置き場 */
let RUN_DIR = "";

/** 観察結果（シナリオ × モード） */
let results = [];
/** 絶対チェックに引っかかったこと */
let absoluteFailures = [];
/** external なのに原文が書き換わったファイル（シナリオごとに溜めて名前を付ける） */
let sourceRewrites = [];
/** 絞り込み（--only）。null なら全部 */
let ONLY = null;
/** 下ごしらえの所要時間を出すか（--time） */
let SHOW_TIME = false;

/** 画面へ出した行の控え（run ディレクトリへ残す） */
const logLines = [];

function say(text = "") {
	logLines.push(text);
	process.stdout.write(`${text}\n`);
}

// mdait 側の細かいつぶやきは読みづらいので落とす（旧実装と同じ扱い）
const isNoise = (a) => {
	const s = String(a[0] != null ? a[0] : "");
	return s.startsWith("StatusManager:") || s.startsWith("DefaultAIProvider");
};
const origLog = console.log;
const origWarn = console.warn;
function quietConsole() {
	console.log = (...a) => {
		if (isNoise(a)) return;
		origLog(...a);
	};
	console.warn = (...a) => {
		if (isNoise(a)) return;
		origWarn(...a);
	};
}

// ===========================================================================
// 土台への頼みごと（ホストに実際のコマンドを走らせてもらう）
// ===========================================================================

/**
 * ホストが依頼の紙（command.json）を片付けるまで待つ。
 *
 * ホストは「結果を書く → 依頼の紙を捨てる」の順で動く。結果を見てすぐ次の依頼を置くと、
 * まだ捨てていない紙と入れ替わり、ホストがその**新しい紙のほう**を捨ててしまうことがある
 * （こちらは返事を待ち続け、実測で1800回に1回ほど止まった）。紙が消えるのを見届けてから
 * 次を置けば、この取り違えは起こらない。
 */
async function waitCommandConsumed(limitMs = 5000) {
	const { commandFile } = ipcPaths(WS);
	const limit = Date.now() + limitMs;
	while (Date.now() < limit) {
		if (!fs.existsSync(commandFile)) return true;
		await new Promise((r) => setTimeout(r, 20));
	}
	return false;
}

/** 1つ頼んで結果を待つ。つまずいたら画面に出して先へ進む（1件で全体を止めない） */
async function ask(command, args = [], timeoutSec = 120) {
	let result;
	try {
		result = await sendCommand(WS, command, args, { timeoutSec });
	} catch (e) {
		// 返事が来ないのは、上に書いた紙の取り違えでほぼ説明が付く。1度だけ置き直す
		say(`  ${command} の返事が来ないので、もう一度頼みます: ${e?.message}`);
		result = await sendCommand(WS, command, args, { timeoutSec });
	}
	if (result.status === "error") say(`  ${command} でつまずきました: ${result.error}`);
	await waitCommandConsumed();
	return result;
}

/** 全体の同期 */
async function hostSync() {
	return ask("mdait.sync", []);
}

/** 1ファイルを翻訳する（渡すのは訳文の側のパス） */
async function hostTrans(abs) {
	return ask("mdait.trans", [abs]);
}

/** ホストに「覚えていた中身を捨ててディスクから読み直せ」と言う */
async function hostReload() {
	const result = await sendCommand(WS, "lab.reload", [], { timeoutSec: 120 });
	await waitCommandConsumed();
	return result;
}

// ===========================================================================
// ホストの頭の中を触る操作（土台に入口が無いぶんだけ、ここで out/ を直に呼ぶ）
// ===========================================================================

/** 読み込んだ out/ の部品置き場（一度だけ作る） */
let stack = null;

function loadStack() {
	if (stack) return stack;
	// どこを作業場とみなすかは、vscode の肩代わりを読み込む**前**に決める
	process.env.MDAIT_LAB_WS = WS;
	process.env.MDAIT_DEBUG_IPC = "1";
	global.__mdaitLabWorkspaceRoot = WS;
	const req = createRequire(import.meta.url);
	const { vscode } = req(path.join(REPO, "scripts", "lab", "vscode-shim.js"));
	const load = (rel) => req(path.join(REPO, "out", rel));
	const renameFollow = load("commands/markers/rename-follow.js");
	const sync = load("commands/sync/sync-command.js");
	stack = {
		vscode,
		Configuration: load("infra/config/configuration.js").Configuration,
		UnitStateStore: load("core/unit-state/unit-state-store.js").UnitStateStore,
		UnitRegistryManager: load("core/unit-registry/unit-registry-manager.js").UnitRegistryManager,
		StatusManager: load("core/status/status-manager.js").StatusManager,
		SelectionState: load("core/status/selection-state.js").SelectionState,
		markdownParser: load("core/markdown/parser.js").markdownParser,
		resolveMarkerIOForFile: load("infra/config/marker-io.js").resolveMarkerIOForFile,
		MdaitMarker: load("core/markdown/mdait-marker.js").MdaitMarker,
		serializeFrontmatterMarker: load("core/markdown/frontmatter-translation.js").serializeFrontmatterMarker,
		buildRenameFollowEdit: renameFollow.buildRenameFollowEdit,
		completeRenameFollow: renameFollow.completeRenameFollow,
		syncCommand: sync.syncCommand,
		syncSingleFile: sync.syncSingleFile,
	};
	return stack;
}

/**
 * こちら側が覚えている中身を捨てて、ディスクから読み直す。
 *
 * ホストが書いたあとの姿を見るためにも、こちらが書く前に古い姿を持ち込まないためにも要る。
 * 対象言語の選択（SelectionState）はディスクに無いので、ここでは触らない。
 */
async function refreshLocal() {
	const s = loadStack();
	s.UnitRegistryManager.resetInstance();
	s.UnitStateStore.dispose();
	if (s.StatusManager.dispose) s.StatusManager.dispose();
	await s.Configuration.getInstance().load();
	s.UnitStateStore.getInstance().ensureLoaded(s.Configuration.getInstance().getMdaitDir());
}

/** 対象言語の選択を差し替える（sync が走査するペアを絞る） */
function selectTargets(keys) {
	loadStack().SelectionState.getInstance().updateSelection(keys);
}

/** こちらのプロセスで sync を回す（選択を絞った状態を渡せるのはここだけ） */
async function localSync() {
	await refreshLocal();
	await loadStack().syncCommand();
	await hostReload();
}

/** 保存のたびに走る単ファイル同期を再現する（S87） */
async function localSyncSingleFile(abs) {
	await refreshLocal();
	await loadStack().syncSingleFile(abs);
	await hostReload();
}

/**
 * VS Code のエクスプローラでの移動を模す（段階2 / roadmap-v01 の P02）。
 *
 * 実運用ではファイルは `onWillRenameFiles` の `waitUntil` に返した WorkspaceEdit で動く。
 * ここでは製品と**同じ2つの入口**（`buildRenameFollowEdit` / `completeRenameFollow`）を
 * 同じ順序で呼び、その間に VS Code がやることだけをディスク操作で埋める。
 * VS Code を起動せずにペアの導出・重複の排除・行の追随を実測できる。
 *
 * 生の `fs.renameSync` を使うシナリオ（S6 など）は「VS Code の外で動かされた場合」を
 * 測っており、そちらは段階4（内容による再リンク）が受け持つ。混ぜないこと。
 *
 * @param moves [[移動元, 移動先], ...]（content からの相対パス）
 */
async function renameViaEditor(moves) {
	await refreshLocal();
	const s = loadStack();
	const files = moves.map(([from, to]) => ({
		oldUri: s.vscode.Uri.file(path.join(CONTENT, from)),
		newUri: s.vscode.Uri.file(path.join(CONTENT, to)),
	}));
	// onWillRenameFiles: 連れて動かす訳文を編集へ載せる
	const edit = s.buildRenameFollowEdit(files);
	// VS Code が編集を適用するところ（ユーザーぶん＋連れて動かすぶん）
	for (const m of [...files, ...edit.renamedFiles]) {
		fs.mkdirSync(path.dirname(m.newUri.fsPath), { recursive: true });
		fs.renameSync(m.oldUri.fsPath, m.newUri.fsPath);
	}
	// onDidRenameFiles: 行を実態に合わせる
	await s.completeRenameFollow(files);
	await hostReload();
}

// ===========================================================================
// ディスクを直に触る道具（原稿の編集・章の切り貼り）
// ===========================================================================

/** dir 配下を再帰走査し、dir からの相対パス（/区切り）を返す */
function walkRelative(dir, base = dir, out = []) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, e.name);
		if (e.isDirectory()) walkRelative(full, base, out);
		else out.push(path.relative(base, full).split(path.sep).join("/"));
	}
	return out;
}

function rmrf(p) {
	if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function write(rel, text) {
	const p = path.join(CONTENT, rel);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, text);
}

function read(rel) {
	const p = path.join(CONTENT, rel);
	return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
}

function unitState() {
	const p = path.join(MDAIT, "unit-state");
	return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
}

/**
 * 原文が置かれているディレクトリ（絶対パス）。
 *
 * ピボット構成（ja→en, en→fr）の中間言語は原文であると同時に訳文でもあるので外す。
 * そちらは mdait が書き換えてよいファイルで、「書き換えていないこと」を求める対象ではない。
 */
function sourceDirsOf(pairs) {
	const list = pairs || DEFAULT_PAIRS;
	const targets = new Set(list.map((p) => path.normalize(p.targetDir)));
	const dirs = [];
	for (const p of list) {
		const norm = path.normalize(p.sourceDir);
		if (targets.has(norm)) continue;
		const abs = path.join(WS, norm);
		if (!dirs.includes(abs)) dirs.push(abs);
	}
	return dirs;
}

/** 原文ファイルのバイト列を控える */
function snapshotSources(pairs) {
	const snap = new Map();
	for (const dir of sourceDirsOf(pairs)) {
		if (!fs.existsSync(dir)) continue;
		for (const rel of walkRelative(dir)) {
			const abs = path.join(dir, rel);
			snap.set(abs, fs.readFileSync(abs));
		}
	}
	return snap;
}

/**
 * 「external で原文が1バイトも書き換わらない」を全シナリオで見る絶対チェック
 * （roadmap-v01 の P05 / ADR-260802-04 のゴールそのもの）。
 *
 * embedded は原文にマーカーを書くのが仕様なので external のときだけ見る。
 * マーカーの有無ではなく**バイト列**を比べる — 空行の入れ方や改行コードが変わる形の
 * 書き換えは、原稿を預ける相手にとってマーカーの混入と同じ「勝手に書き換わった」である。
 *
 * 消えた・動いたファイルは書き換えではないので見ない（シナリオ側の操作の結果）。
 * モードの往復のように**原文を書き換えること自体が目的**の操作は allow で外す。
 */
async function withSourceIntact(mode, pairs, allow, fn) {
	if (mode !== "external" || allow) return fn();
	const before = snapshotSources(pairs);
	const result = await fn();
	for (const [abs, bytes] of before) {
		if (!fs.existsSync(abs)) continue;
		if (fs.readFileSync(abs).equals(bytes)) continue;
		const rel = path.relative(WS, abs).split(path.sep).join("/");
		if (!sourceRewrites.includes(rel)) sourceRewrites.push(rel);
	}
	return result;
}

/** 対象ファイルのユニット一覧を「モードに依らない形」で読む */
function unitsOf(rel) {
	const abs = path.join(CONTENT, rel);
	if (!fs.existsSync(abs)) return null;
	const s = loadStack();
	const config = s.Configuration.getInstance();
	const io = s.resolveMarkerIOForFile(config, abs);
	const doc = s.markdownParser.parse(fs.readFileSync(abs, "utf8"), config, io.provider, io.ctx);
	return doc.units.map((u) => ({
		title: u.title || "(no title)",
		need: u.marker?.need || "",
		hash: u.marker?.hash || "",
		from: u.marker?.from || "",
		body: u.content.replace(/\s+/g, " ").trim().slice(0, 40),
	}));
}

/**
 * frontmatter マーカーの中身を「モードに依らない形」で返す。無ければ null。
 *
 * 置き場所はモードで変わる（embedded はファイルの frontmatter、external は
 * `.mdait/unit-state` の予約席）。ファイルを直に読むと external 側だけ常に null になり、
 * **全シナリオが「想定外の差」に化ける**。比べたいのは保管形式ではなく結果なので、
 * `unitsOf` と同じく置き場所を吸収してから比べる。
 */
function frontMarker(rel) {
	const abs = path.join(CONTENT, rel);
	if (!fs.existsSync(abs)) return null;
	const s = loadStack();
	if (s.Configuration.getInstance().isExternalMarkers()) {
		const key = path.relative(WS, abs).split(path.sep).join("/");
		const entry = s.UnitStateStore.getInstance().getFrontMatterEntry(key);
		if (!entry) return null;
		// 表示の形は embedded 側（frontmatter に書かれる文字列）に揃える
		return s.serializeFrontmatterMarker(new s.MdaitMarker(entry.hash, entry.from || null, entry.need || null));
	}
	const lines = fs.readFileSync(abs, "utf8").split("\n");
	if (lines[0] !== "---") return null;
	for (let i = 1; i < lines.length && lines[i] !== "---"; i++) {
		const m = /^\s+front:\s*(.*)$/.exec(lines[i]);
		if (m) return m[1].trim().replace(/^'|'$/g, "");
	}
	return null;
}

function fmtUnits(rel) {
	const us = unitsOf(rel);
	if (!us) return `${rel}: (ファイル無し)`;
	const fm = frontMarker(rel);
	const lines = us.map(
		(u, i) =>
			`    [${i}] ${u.title.padEnd(14)} need=${(u.need || "-").padEnd(18)} hash=${u.hash || "--------"} from=${u.from || "--------"} | ${u.body}`,
	);
	if (fm) lines.unshift(`    [fm] frontmatter        ${fm}`);
	return `${rel}:\n${lines.join("\n")}`;
}

/**
 * 見出し行を先頭とする「章ブロック」の行範囲を返す。
 * embedded では見出し直前のマーカー行もブロックに含める（人が章ごと切り貼りする実態に合わせる）。
 */
function blockRange(lines, heading) {
	const h = lines.findIndex((l) => l.trim() === heading);
	if (h < 0) return null;
	let start = h;
	if (h > 0 && /^<!--\s*mdait\b/.test(lines[h - 1].trim())) start = h - 1;
	let end = lines.length;
	for (let i = h + 1; i < lines.length; i++) {
		if (/^#{1,6}\s/.test(lines[i]) || /^<!--\s*mdait\b/.test(lines[i].trim())) {
			end = i;
			break;
		}
	}
	return [start, end];
}

/** 章ブロックを丸ごと削除する */
function removeChapter(rel, heading) {
	const lines = read(rel).split("\n");
	const r = blockRange(lines, heading);
	if (!r) throw new Error(`chapter not found: ${heading}`);
	lines.splice(r[0], r[1] - r[0]);
	write(rel, lines.join("\n"));
}

/** 指定見出しのブロックの直前に、マーカー無しの新しい章を挿入する */
function insertChapterBefore(rel, heading, block) {
	const lines = read(rel).split("\n");
	const r = blockRange(lines, heading);
	if (!r) throw new Error(`chapter not found: ${heading}`);
	lines.splice(r[0], 0, ...block.split("\n"));
	write(rel, lines.join("\n"));
}

/** 2つの章ブロックを入れ替える */
function swapChapters(rel, headingA, headingB) {
	const lines = read(rel).split("\n");
	const a = blockRange(lines, headingA);
	const b = blockRange(lines, headingB);
	if (!a || !b || a[1] > b[0]) throw new Error("swap: 想定外のブロック順");
	const A = lines.slice(a[0], a[1]);
	const mid = lines.slice(a[1], b[0]);
	const B = lines.slice(b[0], b[1]);
	const rest = lines.slice(b[1]);
	write(rel, [...lines.slice(0, a[0]), ...B, ...mid, ...A, ...rest].join("\n"));
}

/** 本文の一部を置換する（マーカーは触らない＝実際の編集に近い） */
function editBody(rel, from, to) {
	const t = read(rel);
	if (!t.includes(from)) throw new Error(`body not found: ${from}`);
	write(rel, t.replace(from, to));
}

/**
 * 章ブロックの見出し行（と embedded のマーカー行）を落として本文だけ残す＝直前の章へ統合する。
 * 人が「章立てをやめて前の章に吸収した」操作に相当する。
 */
function mergeChapterIntoPrevious(rel, heading) {
	const lines = read(rel).split("\n");
	const r = blockRange(lines, heading);
	if (!r) throw new Error(`chapter not found: ${heading}`);
	const kept = lines.slice(r[0], r[1]).filter((l) => l.trim() !== heading && !/^<!--\s*mdait\b/.test(l.trim()));
	lines.splice(r[0], r[1] - r[0], ...kept);
	write(rel, lines.join("\n"));
}

/**
 * 同じ見出しが何度も出てくる文書のために、n 番目（0始まり）の出現に対する章ブロック範囲を返す。
 * blockRange と同じ規則（embedded では直前のマーカー行も含める）。
 */
function blockRangeNth(lines, heading, n) {
	let seen = -1;
	let h = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].trim() === heading) {
			seen++;
			if (seen === n) {
				h = i;
				break;
			}
		}
	}
	if (h < 0) return null;
	let start = h;
	if (h > 0 && /^<!--\s*mdait\b/.test(lines[h - 1].trim())) start = h - 1;
	let end = lines.length;
	for (let i = h + 1; i < lines.length; i++) {
		if (/^#{1,6}\s/.test(lines[i]) || /^<!--\s*mdait\b/.test(lines[i].trim())) {
			end = i;
			break;
		}
	}
	return [start, end];
}

/** n 番目（0始まり）の同名見出しの章ブロックを丸ごと削除する */
function removeChapterNth(rel, heading, n) {
	const lines = read(rel).split("\n");
	const r = blockRangeNth(lines, heading, n);
	if (!r) throw new Error(`chapter not found: ${heading}#${n}`);
	lines.splice(r[0], r[1] - r[0]);
	write(rel, lines.join("\n"));
}

/** n 番目（0始まり）の同名見出しの章ブロックの直前に新しい章を挿入する */
function insertChapterBeforeNth(rel, heading, n, block) {
	const lines = read(rel).split("\n");
	const r = blockRangeNth(lines, heading, n);
	if (!r) throw new Error(`chapter not found: ${heading}#${n}`);
	lines.splice(r[0], 0, ...block.split("\n"));
	write(rel, lines.join("\n"));
}

/** 章ブロックを丸ごと文書末尾へ移す（embedded ではマーカーごと動く＝人が切り貼りした形） */
function moveChapterToEnd(rel, heading) {
	const lines = read(rel).split("\n");
	const r = blockRangeNth(lines, heading, 0);
	if (!r) throw new Error(`chapter not found: ${heading}`);
	const block = lines.slice(r[0], r[1]);
	lines.splice(r[0], r[1] - r[0]);
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	write(rel, [...lines, "", ...block].join("\n"));
}

/**
 * 末尾から n 個の `## ` 章ブロックを削除する（embedded では直前のマーカー行も落とす）。
 * 「章をまとめて大きく減らした」操作をモードに依らず作るために使う。
 */
function removeLastChapters(rel, n) {
	const lines = read(rel).split("\n");
	for (let k = 0; k < n; k++) {
		let h = -1;
		for (let i = lines.length - 1; i >= 0; i--) {
			if (/^##\s/.test(lines[i])) {
				h = i;
				break;
			}
		}
		if (h < 0) throw new Error(`no chapter left in ${rel}`);
		let start = h;
		if (h > 0 && /^<!--\s*mdait\b/.test(lines[h - 1].trim())) start = h - 1;
		lines.splice(start, lines.length - start);
	}
	write(rel, `${lines.join("\n")}\n`);
}

/**
 * 文書の途中の章を1つ消す（0起点で index 番目の `## ` 章）。
 *
 * 末尾を消す `removeLastChapters` と違い、消えた場所が「行の並びの途中」になる。
 * 末尾を見る刈り取り／保留はここでは何も拾えないため、対応が付かなかった行を
 * 読み込み時に見つけて預ける経路（P03）でしか守れない。
 */
function removeChapterAt(rel, index) {
	const lines = read(rel).split("\n");
	const heads = [];
	for (let i = 0; i < lines.length; i++) {
		if (/^##\s/.test(lines[i])) heads.push(i);
	}
	if (index >= heads.length) throw new Error(`no chapter #${index} in ${rel}`);
	let start = heads[index];
	if (start > 0 && /^<!--\s*mdait\b/.test(lines[start - 1].trim())) start = start - 1;
	const end = index + 1 < heads.length ? heads[index + 1] : lines.length;
	let stop = end;
	if (stop > 0 && stop <= lines.length && /^<!--\s*mdait\b/.test((lines[stop - 1] || "").trim())) stop = stop - 1;
	lines.splice(start, stop - start);
	write(rel, `${lines.join("\n")}\n`);
}

/** 文書の末尾へ新しい章を足す（マーカー無し＝人が書き足した形） */
function appendChapter(rel, heading, body) {
	write(rel, `${read(rel).replace(/\s*$/, "\n")}\n${heading}\n\n${body}\n`);
}

/** 見出し行のレベルだけを変える（本文・マーカーは触らない） */
function changeHeadingLevel(rel, heading, newHeading) {
	const lines = read(rel).split("\n");
	const h = lines.findIndex((l) => l.trim() === heading);
	if (h < 0) throw new Error(`chapter not found: ${heading}`);
	lines[h] = newHeading;
	write(rel, lines.join("\n"));
}

// ===========================================================================
// 原稿の見本
// ===========================================================================

const SRC = [
	"# ドキュメント",
	"",
	"導入の文章。",
	"",
	"## 第1章",
	"",
	"第1章の本文。",
	"",
	"## 第2章",
	"",
	"第2章の本文。",
	"",
	"## 第3章",
	"",
	"第3章の本文。",
	"",
].join("\n");

/** 非Markdown の原文（S84 / S85 用。ファイル＝単一ユニットの特殊形を測る） */
const TXT_SRC = ["これは注意書きです。", "", "取り扱いに気をつけてください。", ""].join("\n");

/** 同じディレクトリに置くもう1本の原文（S9 用。ディレクトリが空にならないようにする） */
const OTHER_SRC = ["# もう一つの文書", "", "こちらの導入。", "", "## 付録", "", "付録の本文。", ""].join("\n");

/** コピペで作られた同一本文の章を2つ持つ原文（S24/S25 用） */
const DUP_SRC = [
	"# ドキュメント",
	"",
	"導入の文章。",
	"",
	"## 注意事項",
	"",
	"安全に配慮してください。",
	"",
	"## 第2章",
	"",
	"第2章の本文。",
	"",
	"## 注意事項",
	"",
	"安全に配慮してください。",
	"",
	"## 第3章",
	"",
	"第3章の本文。",
	"",
].join("\n");

/** frontmatter を持つ原文（S33/S34 用。frontmatter マーカーは現状どちらのモードでも本文側に残る） */
const FM_SRC = ["---", 'title: "ガイド"', 'description: "ガイドの説明"', "---", "", ...SRC.split("\n")].join("\n");

// ---- S40〜 用の「病的な文書」たち ----

/** まったく同じ本文の章が3つある原文（S40〜S42） */
const TRIPLE_SRC = [
	"# ドキュメント",
	"",
	"導入の文章。",
	"",
	"## 注意事項",
	"",
	"安全に配慮してください。",
	"",
	"## 第2章",
	"",
	"第2章の本文。",
	"",
	"## 注意事項",
	"",
	"安全に配慮してください。",
	"",
	"## 第3章",
	"",
	"第3章の本文。",
	"",
	"## 注意事項",
	"",
	"安全に配慮してください。",
	"",
].join("\n");

/** 本文が空の章（見出しだけの章）が並ぶ原文。うち2つは見出しまで同一（S43・S44） */
const HEADONLY_SRC = [
	"# ドキュメント",
	"",
	"導入の文章。",
	"",
	"## 用語",
	"",
	"## 記法",
	"",
	"## 予約",
	"",
	"## 予約",
	"",
	"## まとめ",
	"",
	"まとめの本文。",
	"",
].join("\n");

/** 同じ見出しがレベル違いで同居する原文（S45・S46） */
const LEVEL_SRC = [
	"# ドキュメント",
	"",
	"導入の文章。",
	"",
	"## 概要",
	"",
	"概要の本文。",
	"",
	"### 概要",
	"",
	"詳細な概要の本文。",
	"",
	"## 手順",
	"",
	"手順の本文。",
	"",
	"### 概要",
	"",
	"もうひとつの詳細。",
	"",
].join("\n");

/** 見出しに属さない前書きから始まる原文（S47・S48） */
const PREAMBLE_SRC = [
	"前書きの文章。どの見出しにも属さない。",
	"",
	"# ドキュメント",
	"",
	"導入の文章。",
	"",
	"## 第1章",
	"",
	"第1章の本文。",
	"",
	"## 第2章",
	"",
	"第2章の本文。",
	"",
].join("\n");

/** ユニットが1つしかない原文（S52・S53） */
const SINGLE_SRC = ["# ただ一つの章", "", "唯一の本文。", ""].join("\n");

/** 20 章を持つ原文（S54） */
const MANY_SRC = ["# 手引き", "", "導入の文章。", ""]
	.concat(
		Array.from({ length: 20 }, (_, i) => [`## 第${i + 1}節`, "", `第${i + 1}節の本文。`, ""]).reduce(
			(a, b) => a.concat(b),
			[],
		),
	)
	.join("\n");

/** コードブロックの中に mdait マーカーらしき文字列がある原文（design.md P9・S55） */
const CODE_SRC = [
	"# ドキュメント",
	"",
	"導入の文章。",
	"",
	"## コード例",
	"",
	"マーカーの書き方は次のとおりです。",
	"",
	"```markdown",
	"<!-- mdait 12345678 from:87654321 need:translate -->",
	"## サンプル章",
	"",
	"サンプルの本文。",
	"```",
	"",
	"## 第2章",
	"",
	"第2章の本文。",
	"",
].join("\n");

/**
 * 既定の翻訳ペア（ja → en の1本）。
 * シナリオが `pairs` で別の組を指定できるようにしたため、指定が無いときは必ずここへ戻す
 * （前のシナリオが書き換えた mdait.json を次のシナリオが引き継がないようにするため）。
 */
const DEFAULT_PAIRS = [{ sourceLang: "ja", sourceDir: "content/ja", targetLang: "en", targetDir: "content/en" }];

/** 同じディレクトリを "./" 付きで書いたペア（表記ゆれのシナリオ用） */
const DOTTED_PAIRS = [{ sourceLang: "ja", sourceDir: "./content/ja", targetLang: "en", targetDir: "./content/en" }];

/** 訳文2言語（ja → en, ja → fr）。多言語構成のシナリオ用 */
const MULTI_PAIRS = [
	{ sourceLang: "ja", sourceDir: "content/ja", targetLang: "en", targetDir: "content/en" },
	{ sourceLang: "ja", sourceDir: "content/ja", targetLang: "fr", targetDir: "content/fr" },
];

/** コードブロックを `~~~` で囲んだ原文（S72。``` 限定の実装だと素通りする） */
const TILDE_SRC = [
	"# ドキュメント",
	"",
	"導入の文章。",
	"",
	"## コード例",
	"",
	"マーカーの書き方は次のとおりです。",
	"",
	"~~~markdown",
	"<!-- mdait 12345678 from:87654321 need:translate -->",
	"## サンプル章",
	"",
	"サンプルの本文。",
	"~~~",
	"",
	"## 第2章",
	"",
	"第2章の本文。",
	"",
].join("\n");

/** リストと引用の中にコードブロックがある原文（S73。行頭の字下げ・引用記号を落とさないか） */
const NESTED_CODE_SRC = [
	"# ドキュメント",
	"",
	"導入の文章。",
	"",
	"## 手順",
	"",
	"- 手順1: 実行する",
	"  ```js",
	"  console.log(1);",
	"  ```",
	"- 手順2: 確認する",
	"",
	"## 注意",
	"",
	"> 次のように書く。",
	"> ```js",
	"> console.log(2);",
	"> ```",
	"",
].join("\n");

/**
 * 字下げ（4スペース）コードブロックにマーカー風文字列がある原文（S74）。
 * マーカー風の行は**ブロックの2行目以降**に置く。直前が空行だと
 * 「マーカーの前に空行を入れる」処理が発火せず、欠陥を再現できないため。
 */
const INDENTED_CODE_SRC = [
	"# ドキュメント",
	"",
	"導入の文章。",
	"",
	"## コード例",
	"",
	"字下げで書いた例。",
	"",
	"    ## サンプル章",
	"    <!-- mdait 12345678 from:87654321 need:translate -->",
	"    サンプルの本文。",
	"",
	"## 第2章",
	"",
	"第2章の本文。",
	"",
].join("\n");

// ===========================================================================
// 絶対チェックの部品
// ===========================================================================

/**
 * 「この行の並びが、順序も含めてそのまま残っていること」を確かめる絶対チェックを作る。
 * 両モードが揃って壊れる欠陥は突き合わせでは出ないので、結果そのものを見るしかない。
 *
 * 各行が「どこかに在るか」だけを見ると、行の間に何かが挿し込まれても通ってしまう。
 * パーサーがコードブロックの中へ空行を入れる欠陥（B-2）はまさにその形なので、
 * **連続一致**で見る。
 */
function expectLinesIntact(rel, lines) {
	return ({ read }) => {
		const content = read(rel);
		if (content === null) return [`${rel} が存在しない`];
		const block = lines.join("\n");
		if (content.includes(block)) return [];
		// どこで崩れたかを分かりやすく出す（行が消えたのか、間に何か入ったのか）
		const actual = content.split("\n");
		const missing = lines.filter((l) => !actual.includes(l));
		if (missing.length > 0) {
			return missing.map((l) => `${rel} に行が残っていない: ${JSON.stringify(l)}`);
		}
		return [`${rel} で行の並びが崩れている（各行は在るが連続していない）: ${JSON.stringify(block)}`];
	};
}

/** 「この行が在ること」を確かめる（消えていないか）。順序は問わない */
function expectLinesPresent(rel, lines) {
	return ({ read }) => {
		const content = read(rel);
		if (content === null) return [`${rel} が存在しない`];
		const actual = content.split("\n");
		return lines.filter((l) => !actual.includes(l)).map((l) => `${rel} に行が無い: ${JSON.stringify(l)}`);
	};
}

// ===========================================================================
// 下ごしらえとシナリオの型
// ===========================================================================

/** 作業場を空にする。ホストが覚えている中身は、このあとの setMode の読み直しで捨てられる */
function resetAll() {
	rmrf(CONTENT);
	fs.mkdirSync(CONTENT, { recursive: true });
	for (const name of ["unit-state", "unit-registry", "reports"]) rmrf(path.join(MDAIT, name));
}

/**
 * マーカーの置き場・翻訳ペア・管理下の拡張子を書き換えて、ホストとこちらに読み直させる。
 *
 * 旧実装はここで `ai.provider` を `default` に戻していたが、いまは AI の相手が
 * 手元の受け皿（echo）なので触らない。触ると翻訳の答えが返らなくなる。
 */
async function setMode(mode, pairs, extensions) {
	const j = JSON.parse(fs.readFileSync(CFG, "utf8"));
	j.markers = { mode: mode === "external" ? "external" : "embedded" };
	if (pairs) j.transPairs = pairs;
	// 非Markdown（.txt 等）を管理下に入れる／外す。undefined を渡すと既定へ戻す
	if (extensions !== undefined) j.trans = Object.assign({}, j.trans, { extensions });
	else if (j.trans) j.trans = Object.assign({}, j.trans, { extensions: undefined });
	fs.writeFileSync(CFG, JSON.stringify(j, null, 2));
	await hostReload();
	await refreshLocal();
}

/** 初期状態: 原文を置き → sync → trans（echo）→ sync（need クリア） */
async function bootstrap(mode, src, pairs, extraSources, extensions) {
	const t = async (label, fn) => {
		const s = Date.now();
		const r = await fn();
		if (SHOW_TIME) say(`    ${label}: ${Date.now() - s}ms`);
		return r;
	};
	resetAll();
	write("ja/guide.md", src || SRC);
	// 原文をもう1本置くシナリオ用（「ディレクトリの中身の数で挙動が変わる」を測れるようにする）
	for (const [rel, text] of Object.entries(extraSources || {})) write(rel, text);
	await t("setMode", () => setMode(mode, pairs || DEFAULT_PAIRS, extensions));
	await t("sync1", () => withSourceIntact(mode, pairs || DEFAULT_PAIRS, false, () => hostSync()));
	// 全ペアの訳文をすべて翻訳しておく（多言語シナリオの fr 側や、原文が複数あるときの2本目も）
	for (const p of pairs || DEFAULT_PAIRS) {
		const dir = path.join(WS, p.targetDir);
		if (!fs.existsSync(dir)) continue;
		for (const rel of walkRelative(dir)) {
			if (!rel.endsWith(".md")) continue;
			await t(`trans:${p.targetLang}:${rel}`, () => hostTrans(path.join(dir, rel)));
		}
	}
	await t("sync2", () => hostSync());
}

/**
 * 1つのシナリオを embedded と external の両方で流し、結果を控える。
 *
 * @param {string} name 「S3 …」のように先頭に番号を置く（絞り込みと突き合わせの鍵になる）
 * @param {(mode: string) => Promise<void>} mutate 起こす操作
 * @param {object} [opts] src / pairs / extraSources / extensions / transAfter / extraSyncs /
 *   externalOnly / reloadConfig / reloadExtensions / allowSourceRewrite / expect
 */
async function scenario(name, mutate, opts) {
	// 先頭トークン（S3 など）で厳密一致。S3 と S30 が衝突しないよう前方一致にはしない
	if (ONLY && !ONLY.includes(name.split(" ")[0])) return;
	for (const mode of ["embedded", "external"]) {
		sourceRewrites = [];
		await bootstrap(mode, opts?.src, opts?.pairs, opts?.extraSources, opts?.extensions);
		try {
			// external でしか意味を持たない操作（モード切替・表記ゆれ）は embedded 側では何もしない。
			// embedded にとっての等価な操作が no-op だからで、突き合わせは「往復が無損失か」を見る
			if (!opts?.externalOnly || mode === "external") await mutate(mode);
		} catch (e) {
			say(`  mutate error: ${e?.message}`);
		}
		if (opts?.reloadConfig) await setMode(mode, opts.pairs, opts.reloadExtensions);
		await withSourceIntact(mode, opts?.pairs, opts?.allowSourceRewrite, async () => {
			await hostSync();
			// 冪等性の確認用: 何も変えずに sync を追加で回す
			for (let i = 0; i < (opts?.extraSyncs || 0); i++) await hostSync();
			if (opts?.transAfter) {
				for (const rel of opts.transAfter) {
					const abs = path.join(CONTENT, rel);
					if (fs.existsSync(abs)) await hostTrans(abs);
				}
				await hostSync();
			}
		});
		// ホストが書いたあとの姿を、こちらもディスクから読み直してから見る
		await refreshLocal();
		const after = {
			files: walkRelative(CONTENT)
				.filter((f) => f.endsWith(".md"))
				.sort(),
			us: unitState(),
		};
		// 両モードの突き合わせに使う「文書の見え方」。unit-state の中身は
		// external にしか無いので比較には含めない（比べたいのは結果であって保管形式ではない）。
		const view = [`files: ${after.files.join(", ")}`, ...after.files.map((f) => fmtUnits(f))].join("\n");
		results.push({ name, mode, view });
		say(`\n===== ${name} / ${mode} =====`);
		say(`  files: ${after.files.join(", ")}`);
		for (const f of after.files) say(`  ${fmtUnits(f).split("\n").join("\n  ")}`);
		if (mode === "external") say(`  --- unit-state ---\n${after.us.replace(/^/gm, "  ")}`);
		// 絶対チェック（両モードが同じように壊れても気づけるように、結果そのものを見る）
		for (const rel of sourceRewrites) {
			const msg = `external なのに原文が書き換わった: ${rel}`;
			absoluteFailures.push(`${name} / ${mode}: ${msg}`);
			say(`  [絶対チェック失敗] ${msg}`);
		}
		sourceRewrites = [];
		if (opts?.expect) {
			for (const msg of opts.expect({ read, mode }) || []) {
				absoluteFailures.push(`${name} / ${mode}: ${msg}`);
				say(`  [絶対チェック失敗] ${msg}`);
			}
		}
	}
}

/**
 * 両モードで結果が違ってよいシナリオと、その理由。
 * ここに無いシナリオで差が出たら、どちらかの入口だけが直った（または壊れた）ということ。
 */
const EXPECTED_DIFF = {
	S11: "unit-state を消す操作なので embedded には影響が無い",
	S12: "本文からマーカーが消えても external は状態を保つ（external が強い。意図した差）",
	S50: "章を消したうえで残りを見出しごと全面改稿。どの章が消えたかを示す情報がファイルに残らない（外部ストア方式の構造的な限界）",
	S56: "同上（訳文側を全面改稿してから原文の章を削除）",
	S81: "中身が1文字も違わない訳文を2本まとめて VS Code の外で動かした場合。どの行がどのファイルのものか内容から決められないので結び直さない（ADR-260810-01）。誤って結ぶと別文書の翻訳状態が付いて取り返しがつかないが、落としてもいまと同じ＝状態が失われるだけなので、落とす側を選んでいる。embedded は本文にマーカーがあるので動いても失わない",
	// S69 はここにあったが、2026-09-02 の実測で**両モードとも4章すべて訳文ごと完全復帰**した。
	// かつては embedded だけがフェンスに飲まれたユニットの訳を失っていた（マーカーごと飲まれ、
	// from の指す hash が消えるため）。マーカー境界の探索が開始位置にもコードブロック判定を
	// 当てるようになって解消した。差が戻ったら「想定外の差」として出したいので、書き戻さない。
};

/**
 * まだ直していない既知の欠陥。想定内の差とは分けて数え、毎回はっきり出す。
 * 直したらここから消すこと（消し忘れると差が出なくなったことに気づけない）。
 */
const KNOWN_BUGS = {};

/**
 * **両モードが同じように壊れている**ため突き合わせには出ない、未解決の欠陥。
 * 差が出ないので `KNOWN_BUGS` の仕組み（モード差の説明）には載せられないが、
 * 消し忘れに気づけるよう毎回はっきり出す。直したらここから消すこと。
 */
const KNOWN_BUGS_BOTH_MODES = {
	S71: "訳文を手編集してもハッシュが更新されるだけで、編集されたことがどのサーフェスにも出ない（need を付けるのは need の語彙とぶつかるため製品判断待ち。unit-state.md §15 参照）",
};

/** シナリオごとに embedded と external の結果を突き合わせる */
function reportModeParity() {
	const byName = new Map();
	for (const r of results) {
		if (!byName.has(r.name)) byName.set(r.name, {});
		byName.get(r.name)[r.mode] = r.view;
	}
	const unexpected = [];
	let same = 0;
	let expectedDiff = 0;
	let knownBugs = 0;
	say("\n========== embedded と external の突き合わせ ==========");
	for (const [name, v] of byName) {
		if (v.embedded === undefined || v.external === undefined) continue;
		const key = name.split(" ")[0];
		if (v.embedded === v.external) {
			same++;
			if (EXPECTED_DIFF[key] || KNOWN_BUGS[key]) {
				say(`  [注意] ${name}: 差が出る想定だったが一致した（一覧の見直しどき）`);
			}
		} else if (KNOWN_BUGS[key]) {
			knownBugs++;
			say(`  [未修正の既知欠陥] ${name} — ${KNOWN_BUGS[key]}`);
		} else if (EXPECTED_DIFF[key]) {
			expectedDiff++;
			say(`  [想定内の差] ${name} — ${EXPECTED_DIFF[key]}`);
		} else {
			unexpected.push(name);
			say(`  [不一致] ${name}`);
		}
	}
	say(`\n一致 ${same} / 想定内の差 ${expectedDiff} / 未修正の既知欠陥 ${knownBugs} / 想定外の差 ${unexpected.length}`);

	// 突き合わせは相対的な検査なので、両モードが揃って壊れると差が出ない。
	// 結果そのものを見る絶対チェックの失敗はここで別に数える。
	const bothModes = Object.entries(KNOWN_BUGS_BOTH_MODES).filter(([key]) =>
		[...byName.keys()].some((n) => n.split(" ")[0] === key),
	);
	if (bothModes.length > 0) {
		say("\n========== 両モード共通の未修正欠陥（差が出ないので突き合わせでは検出できない） ==========");
		for (const [key, reason] of bothModes) say(`  [未修正] ${key} — ${reason}`);
	}

	say("\n========== 絶対チェック（両モード共通の壊れ方） ==========");
	if (absoluteFailures.length === 0) {
		say("  すべて通過");
	} else {
		for (const m of absoluteFailures) say(`  [失敗] ${m}`);
	}
	say(`\n絶対チェックの失敗 ${absoluteFailures.length}`);

	return {
		same,
		expectedDiff,
		knownBugs,
		unexpected,
		bothModes: bothModes.map(([key, reason]) => ({ key, reason })),
	};
}

// ===========================================================================
// シナリオ本体（S0〜S90）
// ===========================================================================

async function allScenarios() {
	// S0: 基準（何もしない）
	await scenario("S0 何もしない（基準）", async () => {});

	// S1: 原文の1章だけ本文編集
	await scenario("S1 原文の第2章を編集", async () => {
		editBody("ja/guide.md", "第2章の本文。", "第2章の本文（改訂）。");
	});

	// S2: 訳文だけ編集（人手修正）
	await scenario("S2 訳文の第2章を人手編集", async () => {
		editBody("en/guide.md", "第2章の本文。 [MT]", "Chapter 2 (hand-edited)");
	});

	// S3: 章の挿入（中間に新章）
	await scenario("S3 原文の第1章と第2章の間に新章を挿入", async () => {
		insertChapterBefore("ja/guide.md", "## 第2章", "## 第1.5章\n\n第1.5章の本文。\n");
	});

	// S4: 章の削除（中間の章を削除）
	await scenario("S4 原文の第2章を削除", async () => {
		removeChapter("ja/guide.md", "## 第2章");
	});

	// S5: 章の並べ替え
	await scenario("S5 原文の第2章と第3章を入れ替え", async () => {
		swapChapters("ja/guide.md", "## 第2章", "## 第3章");
	});

	// S6: 原文ファイルのリネーム（訳文はそのまま）
	await scenario("S6 原文をリネーム（guide.md → handbook.md）", async () => {
		fs.renameSync(path.join(CONTENT, "ja/guide.md"), path.join(CONTENT, "ja/handbook.md"));
	});

	// S7: 原文・訳文を揃えてリネーム（エディタ上の操作。複数選択で両方を一度に動かす形）
	await scenario("S7 原文・訳文を揃えてリネーム", async () => {
		await renameViaEditor([
			["ja/guide.md", "ja/handbook.md"],
			["en/guide.md", "en/handbook.md"],
		]);
	});

	// S8: サブフォルダへ移動（原文・訳文とも sub/ 配下へ）
	await scenario("S8 原文・訳文をサブフォルダへ移動", async () => {
		await renameViaEditor([
			["ja/guide.md", "ja/sub/guide.md"],
			["en/guide.md", "en/sub/guide.md"],
		]);
	});

	// S9: 原文ファイルの削除。原文をもう1本置いてから片方だけ消す。
	//     原文が1本しか無いと content/ja が0件になり「走査していない」扱いで行が残るため、
	//     ディレクトリに他のファイルが在る実態（＝ふつうのサイト）を測る。
	await scenario(
		"S9 原文ファイルを削除（原文は2ファイル）",
		async () => {
			fs.rmSync(path.join(CONTENT, "ja/guide.md"));
		},
		{ extraSources: { "ja/other.md": OTHER_SRC } },
	);

	// S10: 混合（章挿入 ＋ 本文編集 ＋ リネーム）
	await scenario("S10 混合（章挿入＋編集＋原文/訳文リネーム）", async () => {
		insertChapterBefore("ja/guide.md", "## 第2章", "## 第1.5章\n\n第1.5章の本文。\n");
		editBody("ja/guide.md", "第3章の本文。", "第3章の本文（改訂）。");
		await renameViaEditor([
			["ja/guide.md", "ja/handbook.md"],
			["en/guide.md", "en/handbook.md"],
		]);
	});

	// S11: 外部変更（unit-state を消す = git conflict 解決で捨てた / 別マシンで未生成）
	await scenario("S11 外部変更: unit-state を削除", async () => {
		rmrf(path.join(MDAIT, "unit-state"));
		await hostReload();
		await refreshLocal();
	});

	// S12: 外部変更（訳文ファイルだけ手で全置換＝マーカーごと消える）
	await scenario("S12 外部変更: 訳文からマーカーが消えた状態で戻ってくる", async () => {
		write(
			"en/guide.md",
			[
				"# Document",
				"",
				"Intro.",
				"",
				"## Chapter 1",
				"",
				"Body 1.",
				"",
				"## Chapter 2",
				"",
				"Body 2.",
				"",
				"## Chapter 3",
				"",
				"Body 3.",
				"",
			].join("\n"),
		);
	});

	// S14: 訳文ファイルだけ削除（やり直したいときの典型操作）
	await scenario("S14 訳文ファイルを削除", async () => {
		fs.rmSync(path.join(CONTENT, "en/guide.md"));
	});

	// S13: 章挿入のあと trans まで走らせる（誤対応が訳文本文に及ぶかを見る）
	await scenario(
		"S13 章挿入 → sync → trans（誤対応の実害）",
		async () => {
			insertChapterBefore("ja/guide.md", "## 第2章", "## 第1.5章\n\n第1.5章の本文。\n");
		},
		{ transAfter: ["en/guide.md"] },
	);

	// ---- S20〜: 複合・意地悪シナリオ ----

	// S20: 章の分割（1章を2章に割る）＝ 編集＋挿入の合わせ技
	await scenario("S20 原文の第2章を2つに分割", async () => {
		editBody("ja/guide.md", "第2章の本文。", "第2章の本文（前半）。\n\n## 第2.5章\n\n第2章の本文（後半）。");
	});

	// S21: 章の統合（第3章の見出しを外して第2章に吸収）＝ 編集＋削除の合わせ技
	await scenario("S21 原文の第3章を第2章に統合", async () => {
		mergeChapterIntoPrevious("ja/guide.md", "## 第3章");
	});

	// S22: 見出しレベルを下げる（## → ###）。ユニット数は変わらず level だけ変わる
	await scenario("S22 原文の第2章を ## から ### へ降格", async () => {
		changeHeadingLevel("ja/guide.md", "## 第2章", "### 第2章");
	});

	// S23: 降格して sync したあと元に戻して sync（2段階・自己修復するか）
	await scenario("S23 第2章を ### に降格→sync→## に戻す（2段階）", async () => {
		changeHeadingLevel("ja/guide.md", "## 第2章", "### 第2章");
		await hostSync();
		changeHeadingLevel("ja/guide.md", "### 第2章", "## 第2章");
	});

	// S24: 同一本文の章が2つある文書（コピペ章）の間に新章を挿入
	await scenario(
		"S24 同一本文の章が2つある文書へ章を挿入",
		async () => {
			insertChapterBefore("ja/guide.md", "## 第2章", "## 第1.5章\n\n第1.5章の本文。\n");
		},
		{ src: DUP_SRC },
	);

	// S25: 同一本文の章が2つある文書から、先に出てくる方を削除
	await scenario(
		"S25 同一本文の章のうち先頭側を削除",
		async () => {
			removeChapter("ja/guide.md", "## 注意事項");
		},
		{ src: DUP_SRC },
	);

	// S26: 原文で章を挿入しつつ、訳文の別の章を人手で直す（両側同時編集）
	await scenario("S26 原文へ章挿入＋訳文の別章を人手編集", async () => {
		insertChapterBefore("ja/guide.md", "## 第2章", "## 第1.5章\n\n第1.5章の本文。\n");
		editBody("en/guide.md", "第3章の本文。 [MT]", "Chapter 3 (hand-edited)");
	});

	// S27: 原文で章を挿入し、訳文では別の章を削除（双方の構造が食い違う）
	await scenario("S27 原文へ章挿入＋訳文の第2章を削除", async () => {
		insertChapterBefore("ja/guide.md", "## 第2章", "## 第1.5章\n\n第1.5章の本文。\n");
		removeChapter("en/guide.md", "## 第2章 第2章の本文。 [MT]");
	});

	// S28: 並べ替えとフォルダ移動を同時に行う
	await scenario("S28 章の入れ替え＋原文/訳文をサブフォルダへ移動", async () => {
		swapChapters("ja/guide.md", "## 第2章", "## 第3章");
		await renameViaEditor([
			["ja/guide.md", "ja/sub/guide.md"],
			["en/guide.md", "en/sub/guide.md"],
		]);
	});

	// S29: 挿入して sync → さらに別の章を削除して sync（壊れの上に操作を重ねる）
	await scenario("S29 章挿入→sync→第3章を削除→sync（2段階）", async () => {
		insertChapterBefore("ja/guide.md", "## 第2章", "## 第1.5章\n\n第1.5章の本文。\n");
		await hostSync();
		removeChapter("ja/guide.md", "## 第3章");
	});

	// S30: 先頭ユニット（H1 の導入）を削除する
	await scenario("S30 先頭ユニット（導入 H1）を削除", async () => {
		removeChapter("ja/guide.md", "# ドキュメント");
	});

	// S31: 文書の先頭に新しい H1 を挿入する（全ユニットが1つずれる）
	await scenario("S31 文書の先頭に新しい H1 を挿入", async () => {
		insertChapterBefore("ja/guide.md", "# ドキュメント", "# 新しいタイトル\n\n新しい導入。\n");
	});

	// S32: 壊れた状態で sync を繰り返す（増殖・振動しないか＝冪等性）
	await scenario(
		"S32 章挿入→sync を3回繰り返す（冪等性）",
		async () => {
			insertChapterBefore("ja/guide.md", "## 第2章", "## 第1.5章\n\n第1.5章の本文。\n");
		},
		{ extraSyncs: 2 },
	);

	// S33: frontmatter を持つ文書の途中に章を挿入
	await scenario(
		"S33 frontmatter 付き文書へ章を挿入",
		async () => {
			insertChapterBefore("ja/guide.md", "## 第2章", "## 第1.5章\n\n第1.5章の本文。\n");
		},
		{ src: FM_SRC },
	);

	// S34: frontmatter を持つ文書で frontmatter を編集しつつ章を削除
	await scenario(
		"S34 frontmatter 編集＋章削除",
		async () => {
			editBody("ja/guide.md", 'title: "ガイド"', 'title: "ガイド（改訂）"');
			removeChapter("ja/guide.md", "## 第2章");
		},
		{ src: FM_SRC },
	);

	// S35: frontmatter 付き文書で訳文を捨てて sync で作り直し、同じセッションのまま trans する
	//      （同一内容の再パースで gray-matter のキャッシュに当たるか＝S14 の frontmatter 版）
	await scenario(
		"S35 frontmatter 付き訳文を削除→sync で作り直し→trans",
		async () => {
			fs.rmSync(path.join(CONTENT, "en/guide.md"));
		},
		{ src: FM_SRC, transAfter: ["en/guide.md"] },
	);

	// ---- S40〜: 内容照合アルゴリズムが苦手そうな「病的な文書」 ----

	// S40: 同一本文の章が3つ。真ん中を消すと、残り2つのどちらが消えたか本文からは決まらない
	await scenario(
		"S40 同一本文の章が3つ、真ん中を削除",
		async () => {
			removeChapterNth("ja/guide.md", "## 注意事項", 1);
		},
		{ src: TRIPLE_SRC },
	);

	// S41: 同一本文の章が3つ。2つ目と3つ目のあいだに新章を挿入
	await scenario(
		"S41 同一本文の章が3つ、2つ目と3つ目の間に新章を挿入",
		async () => {
			insertChapterBeforeNth("ja/guide.md", "## 注意事項", 2, "## 第2.5章\n\n第2.5章の本文。\n");
		},
		{ src: TRIPLE_SRC },
	);

	// S42: 同一本文の章が3つ。末尾側を削除しつつ、その手前の章を編集（錨がずれる）
	await scenario(
		"S42 同一本文の章が3つ、末尾を削除＋第2章を編集",
		async () => {
			removeChapterNth("ja/guide.md", "## 注意事項", 2);
			editBody("ja/guide.md", "第2章の本文。", "第2章の本文（改訂）。");
		},
		{ src: TRIPLE_SRC },
	);

	// S43: 見出しだけの章が並ぶ文書から、中間の見出しだけの章を削除
	await scenario(
		"S43 見出しだけの章が並ぶ文書から中間を削除",
		async () => {
			removeChapter("ja/guide.md", "## 記法");
		},
		{ src: HEADONLY_SRC },
	);

	// S44: 見出しだけの章（うち2つは見出しまで同一）の2つ目の直前に、見出しだけの章を挿入
	await scenario(
		"S44 見出しだけ・同名の章の間に見出しだけの章を挿入",
		async () => {
			insertChapterBeforeNth("ja/guide.md", "## 予約", 1, "## 追加\n");
		},
		{ src: HEADONLY_SRC },
	);

	// S45: 同名見出しがレベル違いで同居する文書から、最初の「### 概要」を削除
	await scenario(
		"S45 同名見出し（レベル違い同居）の最初の ### 概要 を削除",
		async () => {
			removeChapterNth("ja/guide.md", "### 概要", 0);
		},
		{ src: LEVEL_SRC },
	);

	// S46: 「## 概要」を「### 概要」へ降格。見出しハッシュ＋レベルが他の章と衝突する
	await scenario(
		"S46 ## 概要 を ### へ降格（同名 ### が2つある文書）",
		async () => {
			changeHeadingLevel("ja/guide.md", "## 概要", "### 概要");
		},
		{ src: LEVEL_SRC },
	);

	// S47: 見出しに属さない前書きを編集する
	await scenario(
		"S47 見出しの無い前書きを編集",
		async () => {
			editBody(
				"ja/guide.md",
				"前書きの文章。どの見出しにも属さない。",
				"前書きの文章（改訂）。どの見出しにも属さない。",
			);
		},
		{ src: PREAMBLE_SRC },
	);

	// S48: 見出しに属さない前書きを丸ごと削除する（先頭ユニットが消える）
	await scenario(
		"S48 見出しの無い前書きを削除",
		async () => {
			const lines = read("ja/guide.md").split("\n");
			const h = lines.findIndex((l) => l.trim() === "# ドキュメント");
			let start = h;
			if (h > 0 && /^<!--\s*mdait\b/.test(lines[h - 1].trim())) start = h - 1;
			write("ja/guide.md", lines.slice(start).join("\n"));
		},
		{ src: PREAMBLE_SRC },
	);

	// S49: 全ユニットの見出しも本文も同時に書き換える（手がかりが1つも残らない）
	await scenario("S49 全ユニットの見出しと本文を同時に全面改稿", async () => {
		editBody("ja/guide.md", "# ドキュメント", "# 手引き");
		editBody("ja/guide.md", "導入の文章。", "はじめにお読みください。");
		editBody("ja/guide.md", "## 第1章", "## 概論");
		editBody("ja/guide.md", "第1章の本文。", "概論の中身。");
		editBody("ja/guide.md", "## 第2章", "## 各論");
		editBody("ja/guide.md", "第2章の本文。", "各論の中身。");
		editBody("ja/guide.md", "## 第3章", "## 結論");
		editBody("ja/guide.md", "第3章の本文。", "結論の中身。");
	});

	// S50: 第1章を削除しつつ、残る第2章・第3章を見出しごと全面改稿
	//      （どの章が消えたかを示す手がかりが本文に一切残らない）
	await scenario("S50 第1章を削除＋第2章・第3章を見出しごと全面改稿", async () => {
		removeChapter("ja/guide.md", "## 第1章");
		editBody("ja/guide.md", "## 第2章", "## 各論");
		editBody("ja/guide.md", "第2章の本文。", "各論の中身。");
		editBody("ja/guide.md", "## 第3章", "## 結論");
		editBody("ja/guide.md", "第3章の本文。", "結論の中身。");
	});

	// S51: 章を入れ替え、さらに移動した片方を編集（確定した対応が単調でなくなる）
	await scenario("S51 第2章と第3章を入れ替え＋第3章を編集", async () => {
		swapChapters("ja/guide.md", "## 第2章", "## 第3章");
		editBody("ja/guide.md", "第3章の本文。", "第3章の本文（改訂）。");
	});

	// S52: ユニットが1つしかない文書の本文を編集
	await scenario(
		"S52 ユニットが1つだけの文書を編集",
		async () => {
			editBody("ja/guide.md", "唯一の本文。", "唯一の本文（改訂）。");
		},
		{ src: SINGLE_SRC },
	);

	// S53: ユニットが1つしかない文書を空にする（ユニット0件＝行の刈り取りが止まる境界）
	await scenario(
		"S53 ユニットが1つだけの文書を空にする",
		async () => {
			write("ja/guide.md", "");
		},
		{ src: SINGLE_SRC },
	);

	// S54: 20 章の文書に、挿入・削除・削除・編集を同時に加える
	await scenario(
		"S54 20章の文書へ複数箇所の挿入・削除・編集",
		async () => {
			insertChapterBefore("ja/guide.md", "## 第5節", "## 第4.5節\n\n第4.5節の本文。\n");
			removeChapter("ja/guide.md", "## 第10節");
			removeChapter("ja/guide.md", "## 第15節");
			editBody("ja/guide.md", "第18節の本文。", "第18節の本文（改訂）。");
		},
		{ src: MANY_SRC },
	);

	// S55: コードブロックの中にマーカーらしき文字列がある文書へ章を挿入し、別の章を編集
	await scenario(
		"S55 コードブロック内にマーカー風文字列がある文書へ章挿入＋編集",
		async () => {
			insertChapterBefore("ja/guide.md", "## コード例", "## 前置き\n\n前置きの本文。\n");
			editBody("ja/guide.md", "第2章の本文。", "第2章の本文（改訂）。");
		},
		{ src: CODE_SRC },
	);

	// S56: 訳文側だけを大きく編集（章削除＋見出しごと改稿）してから、原文の構造も変える
	await scenario("S56 訳文を大幅改稿（章削除＋見出し改稿）→原文の章を削除", async () => {
		removeChapter("en/guide.md", "## 第1章 第1章の本文。 [MT]");
		editBody("en/guide.md", "## 第2章 第2章の本文。 [MT]", "## Chapter Two, fully rewritten by hand");
		editBody("en/guide.md", "## 第3章 第3章の本文。 [MT]", "## Chapter Three, fully rewritten by hand");
		removeChapter("ja/guide.md", "## 第2章");
	});

	// S57: 先頭寄りの章を文書の末尾へ移動する（並べ替えの極端形）
	await scenario("S57 第1章を文書の末尾へ移動", async () => {
		moveChapterToEnd("ja/guide.md", "## 第1章");
	});

	// S58: S55 の切り分け。コードブロック内にマーカー風文字列があるだけで（編集ゼロで）
	//      両モードが食い違うかを見る
	await scenario("S58 コードブロック内マーカー風文字列・操作なし", async () => {}, { src: CODE_SRC });

	// S59: S51 の最小形。3ユニットの文書で2章を入れ替え、そのうち片方を編集する
	await scenario(
		"S59 最小形: 2章を入れ替え＋一方を編集",
		async () => {
			swapChapters("ja/guide.md", "## A", "## B");
			editBody("ja/guide.md", "Bの本文。", "Bの本文（改訂）。");
		},
		{
			src: ["# ドキュメント", "", "導入の文章。", "", "## A", "", "Aの本文。", "", "## B", "", "Bの本文。", ""].join(
				"\n",
			),
		},
	);

	// S61: 訳文の既存章の本文に、マーカー風文字列を含むコードブロックを書き足す
	//      （マーカーを翻訳した文書を訳す、という実際に起きる状況。S58 の訳文側版）
	await scenario("S61 訳文の章にマーカー風文字列入りコードブロックを書き足す", async () => {
		editBody(
			"en/guide.md",
			"## 第2章 第2章の本文。 [MT]",
			[
				"## 第2章 第2章の本文。 [MT]",
				"",
				"```markdown",
				"<!-- mdait 12345678 from:87654321 need:translate -->",
				"## Sample",
				"```",
			].join("\n"),
		);
	});

	// S60: 移動と編集の合わせ技（入れ替えでなく片道の移動でも同じことが起きるか）
	await scenario("S60 第1章を末尾へ移動＋その第1章を編集", async () => {
		moveChapterToEnd("ja/guide.md", "## 第1章");
		editBody("ja/guide.md", "第1章の本文。", "第1章の本文（改訂）。");
	});

	// ---- S62〜: 多言語構成（走査対象外のペアの状態が守られるか） ----

	// S62: ja→en と ja→fr の2ペアがある構成で、en だけを選んで sync する。
	//      走査していない fr の状態が消えないかを見る（消えると fr が全 need:review に倒れる）。
	await scenario(
		"S62 多言語（en/fr）で en だけ選んで sync → 全選択に戻す",
		async () => {
			selectTargets(["en"]);
			editBody("ja/guide.md", "第2章の本文。", "第2章の本文（改訂）。");
			await localSync();
			selectTargets(["en", "fr"]);
		},
		{ pairs: MULTI_PAIRS },
	);

	// S63: S62 の最小形。原文を1文字も触らず、en だけ選んで sync するだけ。
	//      「走査対象外」を「実体が無い」と取り違えていないかを、編集の影響抜きで見る。
	await scenario(
		"S63 多言語（en/fr）で en だけ選んで sync（編集なし）",
		async () => {
			selectTargets(["en"]);
			await localSync();
			selectTargets(["en", "fr"]);
		},
		{ pairs: MULTI_PAIRS },
	);

	// S64: 章を大きく減らして sync（刈り取りが見送られる）→ そのあと新しい章を足す。
	//      取り残された行が、内容の一致しない新章に順序で貼り付かないかを見る。
	//      貼り付くと新章に削除済みの章の from が付き need:revise になる（AI に無関係な差分が渡る）。
	await scenario(
		"S64 章を大きく減らして sync → 新しい章を足す",
		async () => {
			removeLastChapters("ja/guide.md", 15);
			removeLastChapters("en/guide.md", 15);
			await hostSync();
			appendChapter("ja/guide.md", "## 新章", "新章の本文。");
			appendChapter("en/guide.md", "## New Chapter", "Body of the new chapter.");
		},
		{ src: MANY_SRC },
	);

	// S65: S64 のあいだにマーカー保管方式を embedded へ戻してまた external に戻す。
	//      モード切替は external 側だけの操作なので、embedded 側は S64 と同じ手順を踏む
	//      （＝往復が無損失なら S64 と同じ結果になるはず）。
	//      embed が本文へ書き戻せなかった行を消すと、往復後に状態が失われて差が出る。
	await scenario(
		"S65 章を大きく減らす → embedded へ戻す → external に戻す → 新章を足す",
		async (mode) => {
			removeLastChapters("ja/guide.md", 15);
			removeLastChapters("en/guide.md", 15);
			await hostSync();
			if (mode === "external") {
				await setMode("embedded", DEFAULT_PAIRS);
				await hostSync();
				await setMode("external", DEFAULT_PAIRS);
				await hostSync();
			}
			appendChapter("ja/guide.md", "## 新章", "新章の本文。");
			appendChapter("en/guide.md", "## New Chapter", "Body of the new chapter.");
		},
		{ src: MANY_SRC },
	);

	// S67: 同じディレクトリを指したまま、mdait.json の書き方だけを "./content/ja" に変える。
	//      validateForRun が正当と認めている書き方なので、これで状態が消えてはいけない。
	await scenario(
		'S67 sourceDir/targetDir の表記を "./content/ja" 形式へ変える',
		async () => {
			await setMode("external", DOTTED_PAIRS);
			await hostSync();
			await setMode("external", DEFAULT_PAIRS);
		},
		{ externalOnly: true },
	);

	// S68: 訳文を一時的に空にして、1文字も違わない元の内容を貼り戻す。
	//      embedded は本文のマーカーごと戻るので完全復帰する。
	await scenario("S68 訳文を空にして、同じ内容を貼り戻す", async () => {
		const saved = read("en/guide.md");
		write("en/guide.md", "");
		await hostSync();
		write("en/guide.md", saved);
	});

	// S75: 訳し終えた訳文から章を1つ消して sync し、そのあと元の内容を貼り戻す。
	//      sync が原文からその章を作り直すのでユニット数は元に戻り、末尾を見る刈り取り／保留は
	//      どちらも働かない。対応が付かなかったことを知っているのは読み込み時だけなので、
	//      その控えを書き出しまで運んで保留席へ移す（P03 / ADR-260809-01）。
	//      先に訳し終えておくのは、未翻訳のままだと失われる状態が need:translate で、
	//      作り直した結果と区別が付かないためである（＝実害は「訳し終えた章」でだけ出る）。
	await scenario("S75 訳文を訳したあと章を1つ消して sync → 貼り戻す", async () => {
		await hostTrans(path.join(CONTENT, "en/guide.md"));
		await hostSync();
		const saved = read("en/guide.md");
		removeLastChapters("en/guide.md", 1);
		await hostSync();
		write("en/guide.md", saved);
	});

	// S79: S75 の「途中の章」版。末尾ではなく文書のまん中の章を消して sync → 貼り戻す。
	//      末尾を見る刈り取り／保留（shouldPruneTail / parkEntriesFrom）はここでは
	//      何も拾えない。読み込み時に「対応が付かなかった行」を控えて書き出しで
	//      保留席へ移す経路が働いて初めて、貼り戻しで訳が戻る（ADR-260809-01）。
	await scenario("S79 訳文を訳したあと途中の章を消して sync → 貼り戻す", async () => {
		await hostTrans(path.join(CONTENT, "en/guide.md"));
		await hostSync();
		const saved = read("en/guide.md");
		removeChapterAt("en/guide.md", 0);
		await hostSync();
		write("en/guide.md", saved);
	});

	// S80: 原文も訳文も VS Code の外で動かす（git mv・CLI・外部エクスプローラ）。
	//      イベントが来ないので段階2 の追随は働かない。訳し終えた訳文の全ユニットが
	//      「新規」と判定されて need:translate になると、次の翻訳で人の訳が潰れる。
	//      行が覚えている本文 hash と、動いた先の本文の hash が一致するので、
	//      内容で結び直せる（段階4 / ADR-260810-01）。
	await scenario("S80 原文・訳文を VS Code の外で揃えてリネーム", async () => {
		await hostTrans(path.join(CONTENT, "en/guide.md"));
		await hostSync();
		fs.renameSync(path.join(CONTENT, "ja/guide.md"), path.join(CONTENT, "ja/handbook.md"));
		fs.renameSync(path.join(CONTENT, "en/guide.md"), path.join(CONTENT, "en/handbook.md"));
	});

	// S81: S80 と同じ形だが、**中身が1文字も違わない訳文を2本まとめて**外で動かす。
	//      どの行がどのファイルのものか内容から決められないので、結び直さずに落とす。
	//      誤って結ぶと別文書の翻訳状態が付いて取り返しがつかない一方、落としても
	//      いまと同じ（状態が失われる）だけなので、この非対称に合わせて落とす側を選ぶ。
	//      embedded は本文にマーカーがあるので動いても失わない ＝ 意図した差。
	await scenario(
		"S81 外で揃えてリネーム（中身が同じ訳文が2本で決められない）",
		async () => {
			await hostTrans(path.join(CONTENT, "en/guide.md"));
			await hostTrans(path.join(CONTENT, "en/twin.md"));
			await hostSync();
			for (const [from, to] of [
				["ja/guide.md", "ja/handbook.md"],
				["en/guide.md", "en/handbook.md"],
				["ja/twin.md", "ja/notebook.md"],
				["en/twin.md", "en/notebook.md"],
			]) {
				fs.renameSync(path.join(CONTENT, from), path.join(CONTENT, to));
			}
		},
		{ extraSources: { "ja/twin.md": SRC } },
	);

	// S87: S80 と同じ形だが、外で動かしたあと**明示 sync より先に保存が走る**。
	//      autoSyncOnSave は既定で有効なので、動かしたファイルを開いて保存すれば
	//      `syncSingleFile` がまず走る。そこに段階4 の再リンクが無いと、行の無い訳文の
	//      全ユニットが「新規」と判定されて need:translate が書かれ、そのあと明示 sync が
	//      走っても訳文には行があるので再リンクの候補から外れる（＝手がかりが消える）。
	//      人の訳が need:translate に戻ると、次の翻訳でそのまま潰される。
	await scenario("S87 外で揃えてリネーム＋明示 sync の前に保存が走る", async () => {
		await hostTrans(path.join(CONTENT, "en/guide.md"));
		await hostSync();
		fs.renameSync(path.join(CONTENT, "ja/guide.md"), path.join(CONTENT, "ja/handbook.md"));
		fs.renameSync(path.join(CONTENT, "en/guide.md"), path.join(CONTENT, "en/handbook.md"));
		await localSyncSingleFile(path.join(CONTENT, "ja/handbook.md"));
	});

	// S89: S80 と同じ「外で揃えてリネーム」だが、その前に訳文の章を2つ消してある
	//      （＝保留席が2つ立っている）。再リンクの被覆率は「旧行の hash のうち
	//      いまの本文に残っている割合」で測るが、保留席の行まで分母に入れているため
	//      4/6 = 0.667 となり閾値 0.7 を割って結び直せない。frontmatter の行を
	//      分母から外したのと同じ理由（ADR-260810-01）が保留席にも当てはまる。
	await scenario("S89 保留席がある訳文を外で揃えてリネーム", async () => {
		await hostTrans(path.join(CONTENT, "en/guide.md"));
		await hostSync();
		removeChapterAt("en/guide.md", 2);
		removeChapterAt("en/guide.md", 1);
		await hostSync();
		fs.renameSync(path.join(CONTENT, "ja/guide.md"), path.join(CONTENT, "ja/handbook.md"));
		fs.renameSync(path.join(CONTENT, "en/guide.md"), path.join(CONTENT, "en/handbook.md"));
	});

	// S90: frontmatter しか無い原文にあとから本文の章を足す。訳文側は「ユニット0件」だが
	//      frontmatter の行が1つ在るため、S68 の守り（訳文が空で状態が残っているなら中止）が
	//      `countEntriesByPath > 0` で誤発火し、足した章が訳文にいつまでも現れない。
	//      「行が1つも無いときは素通りする」という前提は、本文の行を数えるつもりで書かれている。
	await scenario(
		"S90 frontmatter だけの原文にあとから章を足す",
		async () => {
			write("ja/meta.md", ["---", "title: 見出し", "---", "", "# 新しい章", "", "本文。", ""].join("\n"));
		},
		{ extraSources: { "ja/meta.md": ["---", "title: 見出し", "---", ""].join("\n") } },
	);

	// S76: 原文だけをエディタでリネームする（段階2 の本命）。
	//      訳文を連れて動かさないと、旧訳文が孤立したうえに新パスへ未翻訳の複製訳文が
	//      作られる（unit-state.md §9）。これは embedded でも同じように起きるので、
	//      両モードが揃って「連れて動いた」ことを見る。
	await scenario("S76 原文だけをエディタでリネーム（訳文が連れて動く）", async () => {
		await renameViaEditor([["ja/guide.md", "ja/handbook.md"]]);
	});

	// S77: 原文フォルダごとエディタで移動する。
	//      フォルダの移動はイベント1件でファイルが何十件も動くため、
	//      ディレクトリをディレクトリのまま扱えないと丸ごと取りこぼす。
	await scenario(
		"S77 原文フォルダごとエディタで移動（訳文フォルダも連れて動く）",
		async () => {
			await renameViaEditor([["ja/sub", "ja/moved"]]);
		},
		{ extraSources: { "ja/sub/a.md": OTHER_SRC, "ja/sub/deep/b.md": OTHER_SRC } },
	);

	// S78: 原文をリネームするが、行き先の訳文が既に埋まっている。
	//      上書きで移すと別の訳文がごみ箱も経由せず消えるので、連れて行かない。
	//      連れて行かなかった訳文は原文を失うので、段階1の孤立として画面に出る。
	await scenario(
		"S78 原文をリネーム（行き先の訳文が既にある）",
		async () => {
			await renameViaEditor([["ja/guide.md", "ja/other.md"]]);
		},
		{ extraSources: { "ja/other.md": OTHER_SRC } },
	);

	// ---- レビューの積み残し（申し送りで「まだ試されていない筋書き」として挙がっていたもの） ----

	// S82: 訳文の本文だけ消して frontmatter を残す。ユニット0件だが空ファイルではない。
	//      「訳文が空ならその訳文には触らない」（ADR-260806-02）が frontmatter 付きでも
	//      効くかを見る。効かないと、貼り戻しても全ユニットが need:translate に固定される。
	await scenario(
		"S82 訳文の本文だけ消して frontmatter を残す → 貼り戻す",
		async () => {
			const saved = read("en/guide.md");
			write("en/guide.md", '---\ntitle: "Guide"\ndescription: "The description"\n---\n');
			await hostSync();
			write("en/guide.md", saved);
		},
		{ src: FM_SRC },
	);

	// S83: 訳文側にフェンスの閉じ忘れが入り、以降が全部コードとして飲まれてユニットが潰れる。
	//      S69 は原文側。訳文側は「行を刈るか保留するか」の判断がそのまま当たる場所で、
	//      刈ってしまうとフェンスを直しても訳が戻らない。
	await scenario("S83 訳文にフェンスの閉じ忘れ → sync → 直して sync", async () => {
		const saved = read("en/guide.md");
		write("en/guide.md", saved.replace("## 第1章", "```\n## 第1章"));
		await hostSync();
		write("en/guide.md", saved);
	});

	// S84: 非Markdown（.txt）の訳文を空にする。非MD は「ファイル＝単一ユニット」の特殊形で、
	//      MD とは別のハンドラを通る。空にしたときの守り（ADR-260806-02）が非MD にも
	//      効いているかを見る。
	await scenario(
		"S84 非Markdown（.txt）の訳文を空にして貼り戻す",
		async () => {
			// 先に訳しておく。未翻訳のままだと失われる状態が need:translate で、
			// 作り直した結果と区別が付かない（S75 と同じ理由）
			await hostTrans(path.join(CONTENT, "en/notes.txt"));
			await hostSync();
			const saved = read("en/notes.txt");
			write("en/notes.txt", "");
			await hostSync();
			write("en/notes.txt", saved);
		},
		{ extensions: [".txt"], extraSources: { "ja/notes.txt": TXT_SRC } },
	);

	// S85: 管理下に入れていた .txt を trans.extensions から外して sync する。
	//      §13 の「掃除が永久に効かなくなった」の再来がないか（外した拡張子の行が
	//      走査対象外として永久に残るのか、消えるのか）を実際に見る。
	await scenario(
		"S85 trans.extensions から .txt を外して sync",
		async () => {
			await hostTrans(path.join(CONTENT, "en/notes.txt"));
			await hostSync();
		},
		{
			extensions: [".txt"],
			extraSources: { "ja/notes.txt": TXT_SRC },
			reloadConfig: true,
			reloadExtensions: undefined,
		},
	);

	// S86: 多言語（en/fr）で en だけ選んで sync した状態で、原文を消す。
	//      孤立の判定は「訳文が実在し、導いた原文が実在しない」だけを見るので、
	//      走査していない fr 側も孤立として印が付くはずである。走査の有無で
	//      判定が揺れると、選択を変えるたびに印が出たり消えたりする。
	await scenario(
		"S86 多言語で en だけ sync している状態で原文を消す",
		async () => {
			selectTargets(["en"]);
			fs.unlinkSync(path.join(CONTENT, "ja/guide.md"));
			await localSync();
			selectTargets(["en", "fr"]);
		},
		{ pairs: MULTI_PAIRS, extraSources: { "ja/other.md": OTHER_SRC } },
	);

	// S69: 原文にコードブロックの閉じ忘れが入り、以降の章が全部コードとして飲まれる。
	//      訳文が物理削除されないこと、フェンスを直せば元に戻ることを見る。
	await scenario("S69 原文にフェンスの閉じ忘れ → sync → 直して sync", async () => {
		const saved = read("ja/guide.md");
		editBody("ja/guide.md", "導入の文章。", "導入の文章。\n\n```text");
		await hostSync();
		write("ja/guide.md", saved);
	});

	// S66: 原文ディレクトリは在るが、原文ファイルが一時的に1件も無い状態で sync する。
	//      「見に行ったが0件」を「全部消えた」と読むと、そのペアの行が全消えして
	//      原文を戻したときに全ユニット need:review へ倒れる（S62/S63 と同じ症状）。
	await scenario("S66 原文ファイルを一時退避（ディレクトリは残す）→ sync → 戻す", async () => {
		const abs = path.join(CONTENT, "ja/guide.md");
		const stash = path.join(WS, "guide.md.stash");
		fs.renameSync(abs, stash);
		await hostSync();
		fs.renameSync(stash, abs);
	});

	// S70: 原文の本文を空にする（全選択して消した・別の内容へ差し替える途中など）。
	//      訳文が丸ごと消えないか（＝作業内容が失われないか）を見る
	await scenario("S70 原文の本文を空にする", async () => {
		write("ja/guide.md", "");
	});

	// S71: 訳文の章にコードブロックを書き足す（人手編集の検知）。
	//      ハッシュが変わったことが状態に反映されるかを見る
	await scenario("S71 訳文の章にコードブロックを書き足す", async () => {
		editBody(
			"en/guide.md",
			"## 第2章 第2章の本文。 [MT]",
			["## 第2章 第2章の本文。 [MT]", "", "```js", "console.log(1);", "```"].join("\n"),
		);
	});

	// S72: S58 のチルダ版。コードブロックの囲いが ``` でなくても同じように扱えるか
	//      （``` 限定の実装だと退避を素通りしてマーカー風文字列が本文に露出する）
	await scenario("S72 チルダのコードブロック内マーカー風文字列・操作なし", async () => {}, {
		src: TILDE_SRC,
		expect: expectLinesIntact("ja/guide.md", [
			"~~~markdown",
			"<!-- mdait 12345678 from:87654321 need:translate -->",
			"## サンプル章",
			"",
			"サンプルの本文。",
			"~~~",
		]),
	});

	// S73: リストと引用の中のコードブロック。行頭の字下げ・引用記号ごと守られるか。
	//      両モードが同じように壊れるため突き合わせでは出ない＝絶対チェックで見る
	await scenario("S73 リスト・引用の中のコードブロック・操作なし", async () => {}, {
		src: NESTED_CODE_SRC,
		expect: (ctx) => {
			const msgs = [
				// 原文: リストの中と引用の中、それぞれが連続したまま残っていること
				...expectLinesIntact("ja/guide.md", ["  ```js", "  console.log(1);", "  ```"])(ctx),
				...expectLinesIntact("ja/guide.md", ["> ```js", "> console.log(2);", "> ```"])(ctx),
				// 訳文: コードブロックが字下げ・引用記号ごと「在る」こと。
				//       否定（壊れた形が無い）だけを見ると、丸ごと消えた場合に素通りする
				...expectLinesPresent("en/guide.md", ["  ```js", "  console.log(1);", "> ```js", "> console.log(2);"])(ctx),
			];
			// 訳文側に、字下げ・引用記号を失った裸のフェンスが生えていないこと
			const tgt = ctx.read("en/guide.md");
			if (tgt !== null) {
				const bare = tgt.split("\n").filter((l) => l === "```js").length;
				if (bare > 0) msgs.push(`en/guide.md に字下げ・引用記号を失った \`\`\`js が ${bare} 行ある`);
			}
			return msgs;
		},
	});

	// S74: 字下げ（4スペース）コードブロック内のマーカー風文字列
	await scenario("S74 字下げコードブロック内マーカー風文字列・操作なし", async () => {}, {
		src: INDENTED_CODE_SRC,
		expect: expectLinesIntact("ja/guide.md", [
			"    ## サンプル章",
			"    <!-- mdait 12345678 from:87654321 need:translate -->",
			"    サンプルの本文。",
		]),
	});
}

// ===========================================================================
// 前回の run との差分
// ===========================================================================

/** 観察結果を残した run を新しい順に並べる */
function listObservationRuns() {
	let names = [];
	try {
		names = fs.readdirSync(RUNS_DIR);
	} catch {
		return [];
	}
	return names
		.map((n) => path.join(RUNS_DIR, n, OBSERVATIONS))
		.filter((p) => fs.existsSync(p))
		.sort()
		.reverse();
}

function readObservations(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

/** 2つの見え方を並べて、違うところだけを短く出す */
function diffViews(before, after, limit = 12) {
	const a = before.split("\n");
	const b = after.split("\n");
	const lines = [];
	const max = Math.max(a.length, b.length);
	for (let i = 0; i < max && lines.length < limit; i++) {
		if (a[i] === b[i]) continue;
		if (a[i] !== undefined) lines.push(`      - 前回: ${a[i]}`);
		if (b[i] !== undefined) lines.push(`      + 今回: ${b[i]}`);
	}
	if (lines.length >= limit) lines.push("      …（続きは probe-observations.json を見てください）");
	return lines;
}

/**
 * 前回の観察結果と突き合わせて、変わったところを出す。
 *
 * @param {object} current 今回の観察結果
 * @param {string|null} against 比べる相手のファイル。null なら直前の run を自動で探す
 * @param {boolean} partial --only で絞って走らせたか（絞ったときは「消えた」を言わない）
 */
function reportDiff(current, against, partial) {
	say("\n========== 前回の run との差分 ==========");
	const base = against ? resolveDiffTarget(against) : listObservationRuns()[0];
	if (!base) {
		say("  比べる相手がありません（この run が最初です）");
		return { against: null, changed: [], added: [], removed: [] };
	}
	const prev = readObservations(base);
	if (!prev) {
		say(`  比べる相手を読めませんでした: ${base}`);
		return { against: base, changed: [], added: [], removed: [] };
	}
	say(`  比べた相手: ${base}`);

	const keyOf = (r) => `${r.name} / ${r.mode}`;
	const pm = new Map((prev.scenarios || []).map((r) => [keyOf(r), r.view]));
	const cm = new Map(current.scenarios.map((r) => [keyOf(r), r.view]));
	const changed = [];
	const added = [];
	const removed = [];
	for (const [k, v] of cm) {
		if (!pm.has(k)) added.push(k);
		else if (pm.get(k) !== v) changed.push(k);
	}
	for (const k of pm.keys()) if (!cm.has(k)) removed.push(k);

	const parityChanged =
		prev.parity &&
		(prev.parity.same !== current.parity.same ||
			prev.parity.expectedDiff !== current.parity.expectedDiff ||
			prev.parity.knownBugs !== current.parity.knownBugs ||
			(prev.parity.unexpected || []).length !== current.parity.unexpected.length);
	const failuresChanged = (prev.absoluteFailures || []).join("\n") !== current.absoluteFailures.join("\n");

	if (changed.length === 0 && added.length === 0 && removed.length === 0 && !parityChanged && !failuresChanged) {
		say("  前回と差分なし");
		return { against: base, changed, added, removed };
	}

	if (changed.length > 0) {
		say(`  結果が変わったもの ${changed.length} 件`);
		for (const k of changed) {
			say(`    [変化] ${k}`);
			for (const line of diffViews(pm.get(k), cm.get(k))) say(line);
		}
	}
	if (added.length > 0) {
		say(`  今回から出てきたもの ${added.length} 件`);
		for (const k of added) say(`    [追加] ${k}`);
	}
	if (removed.length > 0) {
		if (partial) {
			say(`  今回は走らせていないもの ${removed.length} 件（--only で絞ったため。消えたわけではありません）`);
		} else {
			say(`  今回は出てこなかったもの ${removed.length} 件`);
			for (const k of removed) say(`    [消失] ${k}`);
		}
	}
	if (parityChanged) {
		const p = prev.parity;
		const c = current.parity;
		say(
			`  突き合わせの数: 一致 ${p.same}→${c.same} / 想定内の差 ${p.expectedDiff}→${c.expectedDiff} / 未修正の既知欠陥 ${p.knownBugs}→${c.knownBugs} / 想定外の差 ${(p.unexpected || []).length}→${c.unexpected.length}`,
		);
	}
	if (failuresChanged) {
		say(`  絶対チェックの失敗: ${(prev.absoluteFailures || []).length} 件 → ${current.absoluteFailures.length} 件`);
	}
	return { against: base, changed, added, removed, parityChanged, failuresChanged };
}

/** --diff に渡されたものを observations のファイルに直す（run ディレクトリでもファイルでも受ける） */
function resolveDiffTarget(target) {
	const abs = path.resolve(target);
	if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
		const file = path.join(abs, OBSERVATIONS);
		return fs.existsSync(file) ? file : null;
	}
	return fs.existsSync(abs) ? abs : null;
}

// ===========================================================================
// 入口
// ===========================================================================

/** すでに動いているか調べる */
function hostAlive(session) {
	if (!session?.hostPid) return false;
	try {
		process.kill(session.hostPid, 0);
		return true;
	} catch {
		return false;
	}
}

/** ホストが動いていなければ、土台の `lab up` に既定の形で起こしてもらう */
function ensureSession() {
	const existing = readSession();
	if (hostAlive(existing) && existing.ws) return existing;
	say("ホストが動いていないので、`lab up --host headless --ai echo --ws tmp --reset` で起こします。");
	execFileSync(
		process.execPath,
		[LAB_CLI, "up", "--host", "headless", "--ai", "echo", "--ws", "tmp", "--reset", "--name", "probe"],
		{ stdio: "inherit" },
	);
	const started = readSession();
	if (!started?.ws) throw new Error("`lab up` のあともセッションの記録が読めません");
	return started;
}

/**
 * 頑健性プローブを一通り流す。
 *
 * @param {{only?: string, time?: boolean, keep?: boolean, diff?: string, noDiff?: boolean}} options
 * @returns {Promise<object>} 観察結果（下の `observations` の形）
 */
export async function run(options = {}) {
	quietConsole();
	const session = ensureSession();
	WS = session.ws;
	CONTENT = path.join(WS, "content");
	MDAIT = path.join(WS, ".mdait");
	CFG = path.join(MDAIT, "mdait.json");
	RUN_DIR = session.runDir && fs.existsSync(session.runDir) ? session.runDir : LAB_DIR;

	results = [];
	absoluteFailures = [];
	sourceRewrites = [];
	ONLY = options.only
		? String(options.only)
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean)
		: null;
	SHOW_TIME = Boolean(options.time);

	say(`作業場: ${WS}`);
	say(`記録の置き場: ${RUN_DIR}`);
	if (ONLY) say(`絞り込み: ${ONLY.join(", ")}`);
	if (session.ai?.mode && session.ai.mode !== "echo") {
		say(`※ AI の相手が ${session.ai.mode} です。訳文が決まった形にならないと結果がぶれます（echo を勧めます）`);
	}

	// 今回の書き出し先。絞って走らせたときは全件の控えと分ける
	const outFile = path.join(RUN_DIR, ONLY ? OBSERVATIONS_PARTIAL : OBSERVATIONS);
	// 差分の相手は、今回の書き出しで消える前に決めておく。
	// まず同じ run の中（＝絞ったまま繰り返し直したとき）、無ければ**過去の run から新しい順に**探す。
	// lab probe は毎回新しい run を作るので、同じ run の中だけを見ると相手が永遠に見つからない
	const fallbackBase = fs.existsSync(outFile) ? outFile : latestObservationsBefore(RUN_DIR, ONLY);

	const startedAt = new Date().toISOString();
	try {
		await allScenarios();
	} finally {
		if (!options.keep) {
			// 次に lab を使う人が「見本の原稿」から始められるように戻しておく
			try {
				const fresh = await prepareWorkspace({ mode: session.wsMode ?? "tmp", reset: true });
				// 作り直すと設定が雛形へ戻る。AI の相手への差し向けを付け直さないと、
				// 次にここを使う人（次回のこのプローブを含む）の翻訳が丸ごと空振りする
				if (session.ai?.baseURL) configureAi(fresh, { mode: session.ai.mode, baseURL: session.ai.baseURL });
				await hostReload();
				say("\n作業場を見本から作り直しました（そのまま見たいときは --keep）");
			} catch (e) {
				say(`\n作業場の作り直しに失敗しました: ${e?.message}`);
			}
		} else {
			say("\n（--keep のため作業場をそのまま残しています）");
		}
	}

	const parity = reportModeParity();
	const observations = {
		startedAt,
		finishedAt: new Date().toISOString(),
		ws: WS,
		runDir: RUN_DIR,
		only: ONLY,
		scenarios: results,
		parity,
		absoluteFailures,
	};

	let diff = null;
	if (!options.noDiff) {
		diff = reportDiff(observations, options.diff ?? fallbackBase, Boolean(ONLY));
	}
	observations.diff = diff;

	// 絞って走らせたときは「想定外の差」を合否に数えない（シナリオを書きながら確かめられるように）。
	// 絶対チェックは1シナリオでも成立するので、いつでも数える。
	observations.ok = ONLY
		? absoluteFailures.length === 0
		: parity.unexpected.length === 0 && absoluteFailures.length === 0;

	// 全文はディスクへ。画面に出したものと同じ並びで残す
	try {
		fs.writeFileSync(outFile, `${JSON.stringify(observations, null, 2)}\n`, "utf8");
		fs.writeFileSync(path.join(RUN_DIR, ONLY ? "probe-partial.log" : "probe.log"), `${logLines.join("\n")}\n`, "utf8");
	} catch (e) {
		say(`記録を残せませんでした: ${e?.message}`);
	}

	say("\n========== DONE ==========");
	return observations;
}

// このファイルを直接動かしたときだけ、自分で最後まで面倒を見る
const invokedDirectly = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
	const opts = parseArgs(process.argv.slice(2), { booleans: ["time", "keep", "no-diff"] });
	run({
		only: opts.only,
		time: opts.time,
		keep: opts.keep,
		diff: opts.diff,
		noDiff: opts["no-diff"],
	})
		.then((observations) => {
			// commands 層はタイマーと見張りを残すので、待っていてもこのプロセスは終わらない
			process.exit(observations.ok ? 0 : 1);
		})
		.catch((e) => {
			process.stdout.write(`PROBE ERROR: ${e?.stack || e}\n`);
			process.exit(1);
		});
}
