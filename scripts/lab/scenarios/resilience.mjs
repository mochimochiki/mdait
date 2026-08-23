#!/usr/bin/env node
/*
 * 壊れた応答への耐性 — AI を使うすべての経路に、同じ意地悪を当てる。
 *
 * いままで意地悪な台本（--ai script）を当てていたのは trans だけだった。
 * ここでは AI を呼ぶ経路を端から並べ、同じ壊れ方を1つずつ当てて、
 * **そのあとに原稿が壊れていないか**を見る。
 *
 * 見る経路（R）
 *   R1-trans        1ファイルを翻訳する
 *   R2-revise       原文を書き換えて need:revise にしてから、改訂の翻訳を当てる
 *   R3-file         ツリーの「ファイルを翻訳」
 *   R4-directory    ツリーの「フォルダを翻訳」
 *   R5-frontmatter  frontmatter だけを翻訳する
 *   R6-termdetect   用語を拾う
 *   R7-termexpand   用語集の空いている訳語を埋める
 *   R8-tmcommit     対訳を翻訳メモリへ登録する
 *   R9-aireview     訳文を AI に見てもらう
 *
 * 当てる意地悪（N）
 *   N1-retry        429 →（送り直し）→ 503 →（送り直し）→ 正常
 *   N2-500          いつでも 500
 *   N3-400          いつでも 400
 *   N4-truncated    途中で切れた JSON（finish_reason: length）
 *   N5-brokensse    壊れた SSE の断片
 *   N6-timeout      長い沈黙（mdait 側のタイムアウトより長く黙る）
 *   N7-empty        空の応答（200 だが本文が空文字）
 *   N8-wrongshape   JSON としては正しいが、期待している形ではない
 *
 * いちばん大事な観点
 *   **翻訳が失敗すること自体は正常な結果でありえる。** 問題なのは失敗の仕方が汚いこと。
 *   だから毎回、実行の前後でファイルの中身とマーカーを突き合わせ、次を見る。
 *     - 原文が1バイトでも変わっていないか
 *     - 訳文の本文が消えていないか（空になる・段落がまるごと落ちる）
 *     - マーカーが厳密文法から外れていないか
 *     - need フラグが宙に浮いていないか（訳していないのに need:translate が消える 等）
 *     - 台帳（unit-state）に幽霊の行が残っていないか
 *     - 用語集・翻訳メモリに、壊れた応答から作られた行が混ざっていないか
 *
 * 判定は2つに分ける（sweep.mjs と同じ決まり。狼少年を避けるためのもの）
 *   FAIL … 製品の側の不具合。原稿が壊れた・状態が矛盾した
 *   INFO … 確かめる道具の側の限界、または仕様として妥当な失敗
 *
 * 動かし方
 *   node scripts/lab/lab.mjs resilience        （まとめ役が配線する呼び方。未配線）
 *   node scripts/lab/scenarios/resilience.mjs  （単独。実験場が無ければ自分で起こす）
 *     --only R1,R8      見たい経路だけ
 *     --nasty N1,N4     当てたい意地悪だけ
 *     --verbose         通った判定（OK）も1件ずつ出す
 *     --keep            単独で動かしたとき、終わっても実験場を止めない
 *
 * AI の相手の作り方（ここだけ sweep と違う）
 *   意地悪は経路ごとに変えたいので、**この段取りが自分で shim を起こす**。
 *   `lab up --ai script --script <1本>` では、経路ごとに違う台本を当てられないうえ、
 *   台本を使い切ると 409 で止まる。ここでは shim を `--script-loop` 付きで起こし、
 *   1件〜3件の短い台本を繰り返させる（ユニットが何個でも同じ意地悪が当たる）。
 *   下ごしらえ（翻訳しておく・用語集を作る）は、ふだんは実験場の echo の相手をそのまま使う。
 *   ただし「まともな訳文」が要る下ごしらえだけは ok-translation.jsonl を使う。
 *   echo は原文を1行に潰すので見出しが落ち、改訂（need:revise）の場面が作れないため。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "../lib/args.mjs";
import { sendCommand } from "../lib/ipc.mjs";
import { saveStep } from "../lib/runs.mjs";
import { LAB_DIR, readSession } from "../lib/session.mjs";
import { configureAi } from "../lib/workspace.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const LAB = path.join(REPO, "scripts", "lab", "lab.mjs");
const SHIM = path.join(REPO, "scripts", "lab", "ai", "shim.mjs");
const SCENARIOS = path.join(REPO, "scripts", "lab", "ai", "scenarios");

/** マーカーの厳密な形（sweep.mjs と同じ）。ここから外れるものは壊れているとみなす */
const MARKER_STRICT = /<!-- mdait(?:\s+([a-zA-Z0-9]+))?(?:\s+from:([a-zA-Z0-9]+))?(?:\s+need:([\w@-]+))?\s*-->/;
/** マーカーらしきものを拾うゆるい形（壊れたものも拾うため） */
const MARKER_LOOSE = /<!--\s*mdait\b[^>]*-->/g;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ===========================================================================
// 判定の記録（sweep.mjs と同じ形）
// ===========================================================================

let findings = [];
let verbose = false;

function say(text = "") {
	process.stdout.write(`${text}\n`);
}

function fail(phase, file, summary, detail) {
	findings.push({ sev: "FAIL", phase, file, summary, detail: detail ?? "" });
	say(`  [FAIL] (${phase}) ${file}: ${summary}`);
}

function info(phase, file, summary, detail) {
	findings.push({ sev: "INFO", phase, file, summary, detail: detail ?? "" });
	say(`  [INFO] (${phase}) ${file}: ${summary}`);
}

function ok(phase, summary) {
	findings.push({ sev: "OK", phase, file: "-", summary, detail: "" });
	if (verbose) say(`  [OK]   (${phase}) ${summary}`);
}

// ===========================================================================
// 実験場の状態
// ===========================================================================

/** いま使っている作業場 */
let ws = "";
/** 記録の置き場。無ければ手順の保存は見送る */
let runDir = null;
/** 実験場が立てた AI の相手（下ごしらえに使う。ふつう echo） */
let baseAi = null;
/** いま立てている意地悪の相手（{pid, port, logFile}）。使い終わったら必ず落とす */
let nastyShim = null;

const FIXTURE = "_resil";

function contentDir() {
	return path.join(ws, "content");
}
function srcDir() {
	return path.join(contentDir(), "ja", FIXTURE);
}
function tgtDir() {
	return path.join(contentDir(), "en", FIXTURE);
}
function configFile() {
	return path.join(ws, ".mdait", "mdait.json");
}
function termsFile() {
	return path.join(ws, ".mdait", "terms.csv");
}
function tmxFile() {
	return path.join(ws, ".mdait", "translations.tmx");
}

function read(file) {
	return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

// ===========================================================================
// 見本の原稿（毎回ここから作り直す）
// ===========================================================================

/**
 * 見本は「1ファイル＝1ユニット」に揃えてある。
 * ユニットが1つなら AI への往復の数が読めるので、意地悪が何回当たったかを数えられる。
 */
const FIXTURE_FILES = {
	"doc.md": "# 見出しA\n\n本文A。壊れた応答のあとでも、この段落は残っていなければならない。\n",
	"doc2.md": "# 見出しB\n\n本文B。二つ目のファイル。フォルダ単位の経路で使う。\n",
	"fm.md": "---\ntitle: 耐性の見本\n---\n\n# 見出しC\n\n本文C。frontmatter つきの見本。\n",
};

/** 見本のファイルを書き戻し、訳文側は捨てる（sync で作り直させる） */
function writeFixtureSources() {
	fs.mkdirSync(srcDir(), { recursive: true });
	for (const [name, body] of Object.entries(FIXTURE_FILES)) {
		fs.writeFileSync(path.join(srcDir(), name), body, "utf8");
	}
	fs.rmSync(tgtDir(), { recursive: true, force: true });
}

// ===========================================================================
// 土台を通した手順
// ===========================================================================

/** コマンドを1つ実行して、結果を run ディレクトリへ残す（`lab run` と同じ道） */
async function runCmd(command, args = [], timeoutSec = 900) {
	const result = await sendCommand(ws, command, args, { timeoutSec });
	if (runDir) {
		try {
			saveStep(runDir, command, result, { args, ws });
		} catch {
			// 記録に失敗しても確かめること自体は続ける
		}
	}
	return result;
}

/** ディスクを入れ替えたあと、ホストに覚えている中身を捨てて読み直してもらう */
async function reload() {
	const result = await sendCommand(ws, "lab.reload", [], { timeoutSec: 120 });
	if (result.status === "error") throw new Error(`ホストの読み直しに失敗しました: ${result.error}`);
}

async function sync() {
	const result = await runCmd("mdait.sync", [], 300);
	if (result.status === "error") throw new Error(`mdait.sync が失敗しました: ${result.error}`);
	return result.result ?? {};
}

// ===========================================================================
// AI の相手の差し替え
// ===========================================================================

/**
 * 意地悪な台本の相手を1つ起こす。
 *
 * `--script-loop` を付けるのがここの肝。台本は1〜3件しかないが、繰り返してくれるので
 * ユニットが何個あっても同じ意地悪が当たり、台本切れ（409）で話がすり替わらない。
 * lab.mjs の `up` はこの旗を渡さないので、ここでは shim を直に起こしている。
 */
let shimSeq = 0;

async function startNastyShim(scriptFile) {
	// ログは相手ごとに別のファイルにする。使い回して切り詰めると、止めたばかりの相手が
	// あとから書き足した行を次の相手の分として数えてしまう（実測で往復の数がずれた）。
	shimSeq += 1;
	const logFile = path.join(LAB_DIR, `resilience-shim-${shimSeq}.log`);
	fs.writeFileSync(logFile, "", "utf8");
	const fd = fs.openSync(logFile, "a");
	const child = spawn(
		process.execPath,
		[SHIM, "--mode", "script", "--port", "0", "--script", scriptFile, "--script-loop"],
		{
			cwd: path.join(REPO, "scripts"),
			detached: true,
			stdio: ["ignore", fd, fd],
			env: { ...process.env, MDAIT_LAB_DIR: LAB_DIR },
		},
	);
	child.unref();
	const limit = Date.now() + 30_000;
	while (Date.now() < limit) {
		const matched = /^PORT=(\d+)/m.exec(fs.readFileSync(logFile, "utf8"));
		if (matched) return { pid: child.pid, port: Number(matched[1]), logFile };
		if (child.exitCode !== null) {
			throw new Error(`意地悪の相手が立ち上がりませんでした。${logFile} を見てください`);
		}
		await sleep(100);
	}
	throw new Error(`意地悪の相手が 30 秒たっても名乗りませんでした。${logFile} を見てください`);
}

function stopNastyShim() {
	if (!nastyShim) return;
	try {
		process.kill(nastyShim.pid, "SIGTERM");
	} catch {}
	nastyShim = null;
}

/** shim が受けた要求の数を、ログから数える */
function nastyRequestCount() {
	if (!nastyShim) return 0;
	const lines = read(nastyShim.logFile).split("\n");
	return lines.filter((line) => /要求 \d+: メッセージ/.test(line)).length;
}

/** 設定の ai を差し替える（baseURL とタイムアウト）。読み直しは呼び出し側が行う */
function pointAiAt(baseURL, timeoutSec) {
	const json = JSON.parse(read(configFile()));
	json.ai = {
		...(json.ai ?? {}),
		provider: "openai",
		model: "byok-shim",
		openai: { ...(json.ai?.openai ?? {}), apiKey: "lab-dummy-key", baseURL, timeoutSec },
		debug: { enableStatsLogging: true, logPromptAndResponse: true },
	};
	fs.writeFileSync(configFile(), `${JSON.stringify(json, null, 2)}\n`, "utf8");
}

/** 下ごしらえ用の相手（実験場が立てた echo）へ戻す */
async function useBaseAi() {
	stopNastyShim();
	if (baseAi?.baseURL) {
		configureAi(ws, { mode: baseAi.mode, baseURL: baseAi.baseURL, timeoutSec: 600 });
		await reload();
	}
}

/** 意地悪の相手へ差し向ける */
async function useNastyAi(scriptFile, timeoutSec) {
	stopNastyShim();
	nastyShim = await startNastyShim(scriptFile);
	pointAiAt(`http://127.0.0.1:${nastyShim.port}/v1`, timeoutSec);
	await reload();
}

/**
 * 下ごしらえで「まともな訳文」が要るときの相手。
 *
 * echo は原文を1行に潰して返すので**見出しが落ちる**。見出しの落ちた訳文は、
 * あとで原文を書き換えても原文ユニットと結び付かず、改訂（need:revise）の場面が作れない
 * （実測: sync が「削除1・新規1」と数え、訳文が未翻訳のコピーに戻った）。
 * だから下ごしらえの翻訳だけは、見出しを残す台本を使う。
 */
async function useGoodAi() {
	await useNastyAi(path.join(SCENARIOS, "ok-translation.jsonl"), 600);
}

// ===========================================================================
// 原稿を見る道具
// ===========================================================================

/** 見本のファイルを丸ごと控える（相対パス → 中身） */
function snapshotFixture() {
	const map = {};
	for (const dir of [srcDir(), tgtDir()]) {
		if (!fs.existsSync(dir)) continue;
		for (const name of fs.readdirSync(dir)) {
			const full = path.join(dir, name);
			if (fs.statSync(full).isFile()) map[path.relative(contentDir(), full)] = read(full);
		}
	}
	map["@terms.csv"] = read(termsFile());
	map["@translations.tmx"] = read(tmxFile());
	map["@unit-state"] = read(path.join(ws, ".mdait", "unit-state"));
	return map;
}

/** 本文にあるマーカーを並べる（frontmatter の中の `front:` 行も1本のマーカーとして拾う） */
function markersOf(content) {
	const found = [...(content.match(MARKER_LOOSE) ?? [])];
	const front = /^\s*front:\s*'([^']*)'/m.exec(content);
	if (front) found.push(`<!-- mdait ${front[1]} -->`);
	return found;
}

/** マーカーの need を取り出す（無ければ空文字） */
function needFlag(markerText) {
	return MARKER_STRICT.exec(markerText)?.[3] || "";
}

/** frontmatter の中のマーカー（`mdait: front: '...'`）だけを取り出す。無ければ空文字 */
function frontMarker(content) {
	const matched = /^\s*front:\s*'([^']*)'/m.exec(content);
	return matched ? `<!-- mdait ${matched[1]} -->` : "";
}

/** マーカーを除いた本文（空かどうかを見るため） */
function bodyOf(content) {
	return content
		.replace(/^---\n[\s\S]*?\n---\n/, "")
		.replace(MARKER_LOOSE, "")
		.trim();
}

/** 見出しの数 */
function headingsOf(content) {
	return content.split("\n").filter((line) => /^#{1,6}\s/.test(line)).length;
}

// ===========================================================================
// 意地悪の一覧
// ===========================================================================

/**
 * @typedef {object} Nasty
 * @property {string} id           N1 など
 * @property {string} label        日本語の呼び名
 * @property {string} script       台本のファイル名（ai/scenarios/ の下）
 * @property {number} timeoutSec   mdait 側の ai.openai.timeoutSec
 * @property {"ok"|"clean-fail"|"garbage"} kind  期待するふるまいの型
 * @property {string} why          なぜその型を期待するか
 */

/** @type {Nasty[]} */
const NASTIES = [
	{
		id: "N1",
		label: "429→503→正常",
		script: "nasty-429-503-then-ok.jsonl",
		timeoutSec: 600,
		kind: "ok",
		why: "429 と 5xx は一時的な失敗なので、送り直して完走するのが正しい",
	},
	{
		id: "N2",
		label: "いつでも500",
		script: "nasty-500.jsonl",
		timeoutSec: 600,
		kind: "clean-fail",
		why: "送り直しても直らないので、最後は失敗する。原稿は触らないのが正しい",
	},
	{
		id: "N3",
		label: "いつでも400",
		script: "nasty-400.jsonl",
		timeoutSec: 600,
		kind: "clean-fail",
		why: "こちらの出し方が悪いという返事なので、送り直さずその場で失敗するのが正しい",
	},
	{
		id: "N4",
		label: "途中で切れたJSON",
		script: "nasty-truncated-json.jsonl",
		timeoutSec: 600,
		kind: "garbage",
		why: "JSON として閉じていない。訳文として採用してはいけない",
	},
	{
		id: "N5",
		label: "壊れたSSE",
		script: "nasty-broken-sse.jsonl",
		timeoutSec: 600,
		kind: "garbage",
		why: "断片が壊れている。例外で落ちてはいけない",
	},
	{
		id: "N6",
		label: "長い沈黙",
		script: "nasty-slow.jsonl",
		timeoutSec: 3,
		kind: "clean-fail",
		why: "タイムアウトで打ち切る。打ち切ったときに原稿を壊してはいけない",
	},
	{
		id: "N7",
		label: "空の応答",
		script: "nasty-empty.jsonl",
		timeoutSec: 600,
		kind: "garbage",
		why: "空を訳文として採用したら本文が消える",
	},
	{
		id: "N8",
		label: "形の違うJSON",
		script: "nasty-wrong-shape.jsonl",
		timeoutSec: 600,
		kind: "garbage",
		why: "検証に落ちたあとの後始末が正しいかを見る",
	},
];

/** 経路ごとに、正常応答の「形」が違う。N1 の最後の1件だけ差し替える */
const RETRY_SCRIPT_BY_SHAPE = {
	translation: "nasty-429-503-then-ok.jsonl",
	terms: "nasty-429-503-then-ok-terms.jsonl",
	tm: "nasty-429-503-then-ok-tm.jsonl",
	map: "nasty-429-503-then-ok-map.jsonl",
};

// ===========================================================================
// 経路の一覧
// ===========================================================================

/**
 * @typedef {object} Route
 * @property {string} id
 * @property {string} label
 * @property {"translation"|"terms"|"tm"|"map"} shape 正常応答の形（N1 で使う）
 * @property {string[]} watch  中身を突き合わせる訳文ファイル（content からの相対）
 * @property {() => Promise<void>} [prepare] 下ごしらえ（AI が要るものは echo で済ませる）
 * @property {() => Promise<object>} act 意地悪を当てた状態で叩くコマンド
 */

/** @type {Route[]} */
const ROUTES = [
	{
		id: "R1",
		label: "trans（1ファイル翻訳）",
		command: "mdait.trans",
		shape: "translation",
		watch: [`en/${FIXTURE}/doc.md`],
		act: () => runCmd("mdait.trans", [path.join(tgtDir(), "doc.md")], 300),
	},
	{
		id: "R2",
		label: "trans（改訂・need:revise）",
		command: "mdait.trans",
		shape: "translation",
		watch: [`en/${FIXTURE}/doc.md`],
		// 下ごしらえ: いちど訳してから原文を書き換え、need:revise を作る。
		// 訳文に「人の書いたもの」が入っている状態で壊れた応答を受けるとどうなるかを見る。
		prepare: async () => {
			// 見出しを残す訳文で下ごしらえする（echo だと見出しが落ちて改訂にならない）
			await useGoodAi();
			await runCmd("mdait.trans", [path.join(tgtDir(), "doc.md")], 300);
			// 原文は**マーカーを残したまま**書き換えること。
			// 丸ごと書き直すとマーカーが落ち、mdait は「別のユニットが増えた」と読む。
			// すると訳文とは結び付かず、改訂ではなく「未翻訳のコピーで置き換え」になる
			// （実測: sync が added=1 / deleted=1 と数え、せっかくの訳文が消えた）。
			const srcFile = path.join(srcDir(), "doc.md");
			fs.writeFileSync(
				srcFile,
				read(srcFile).replace(
					"残っていなければならない。",
					"残っていなければならない。ここを書き換えて改訂を誘発する。",
				),
				"utf8",
			);
			await reload();
			await sync();
		},
		precondition: (before) => {
			const needs = markersOf(before[`en/${FIXTURE}/doc.md`] ?? "").map(needFlag);
			return needs.some((need) => need.startsWith("revise"))
				? null
				: `need:revise が付いていない（いまは ${JSON.stringify(needs)}）`;
		},
		act: () => runCmd("mdait.trans", [path.join(tgtDir(), "doc.md")], 300),
	},
	{
		id: "R3",
		label: "translate.file（ツリーのファイル翻訳）",
		command: "mdait.translate.file",
		shape: "translation",
		watch: [`en/${FIXTURE}/doc.md`],
		act: () => runCmd("mdait.translate.file", [path.join(tgtDir(), "doc.md")], 300),
	},
	{
		id: "R4",
		label: "translate.directory（ツリーのフォルダ翻訳）",
		command: "mdait.translate.directory",
		shape: "translation",
		watch: [`en/${FIXTURE}/doc.md`, `en/${FIXTURE}/doc2.md`, `en/${FIXTURE}/fm.md`],
		act: () => runCmd("mdait.translate.directory", [tgtDir()], 600),
	},
	{
		id: "R5",
		label: "translate.frontmatter（frontmatter だけ翻訳）",
		command: "mdait.translate.frontmatter",
		shape: "translation",
		watch: [`en/${FIXTURE}/fm.md`],
		act: () => runCmd("mdait.translate.frontmatter", [path.join(tgtDir(), "fm.md")], 300),
	},
	{
		id: "R6",
		label: "term.detect（用語を拾う）",
		command: "mdait.term.detect",
		shape: "terms",
		watch: [`ja/${FIXTURE}/doc.md`],
		act: () => runCmd("mdait.term.detect", [srcDir()], 600),
	},
	{
		id: "R7",
		label: "term.expand（訳語を埋める）",
		command: "mdait.term.expand",
		shape: "map",
		watch: [`ja/${FIXTURE}/doc.md`],
		// 下ごしらえ: 訳語の空いた用語集を置く。
		// 空きが無いと「もう埋まっています」で終わり、AI をひとつも呼ばない。
		// 用語は**見本の本文に実際に出てくる語**にすること（出てこない語は
		// 「その語を含む原文が無い」として対象から外れ、やはり AI を呼ばない）。
		prepare: async () => {
			fs.writeFileSync(
				termsFile(),
				"ja,en,context,variants_ja\n段落,,壊れた応答のあとでも、この段落は残っていなければならない。,\n",
				"utf8",
			);
			await reload();
		},
		act: () => runCmd("mdait.term.expand", [tgtDir()], 600),
	},
	{
		id: "R8",
		label: "tm.commit.file（翻訳メモリへ登録）",
		command: "mdait.tm.commit.file",
		shape: "tm",
		watch: [`en/${FIXTURE}/doc.md`],
		// 下ごしらえ: 登録できる「確定した対訳」を作る（need が付いていると見送られる）
		prepare: async () => {
			await useGoodAi();
			await runCmd("mdait.trans", [path.join(tgtDir(), "doc.md")], 300);
			await reload();
		},
		act: () => runCmd("mdait.tm.commit.file", [path.join(tgtDir(), "doc.md")], 300),
	},
	{
		id: "R9",
		label: "aiReview.file（訳文を見てもらう）",
		command: "mdait.aiReview.file",
		shape: "translation",
		watch: [`en/${FIXTURE}/doc.md`],
		// aiReview は最初に「未確認だけ／全部を監査」を QuickPick で選ばせる。
		// vscode-shim.js は一覧の先頭（＝「未確認だけ」）を選ぶので、確認待ちのユニットが
		// 1つも無いと対象0件になり、AI へ行き着かないことがある。
		// そのときは「もう一方（全部を監査）へ切り替えるか」の確認が出て、そこで初めて AI が動く。
		// つまりこの経路は**下ごしらえの状態しだいで意地悪が当たらない**。
		// 当たったかどうかは「AI を1回も呼ばずに終わった」の INFO で見分けること。
		// さらに、対象0件から「全部を監査」へ切り替えたときの2周目は、コマンドの返り値より
		// あとまで走っているように見える（20 秒黙る台本を当てても 0.1 秒で戻る）。
		// だから R9 の「壊れなかった」は、2周目の書き込みまで見届けた結果ではない。
		blocked: "aiReview は冒頭の QuickPick で「未確認だけ」を選ぶため、確認待ちが無いと AI へ行き着かない",
		prepare: async () => {
			await useGoodAi();
			await runCmd("mdait.trans", [path.join(tgtDir(), "doc.md")], 300);
			await reload();
		},
		act: () => runCmd("mdait.aiReview.file", [path.join(tgtDir(), "doc.md")], 300),
	},
];

// ===========================================================================
// 1件ぶんの試し
// ===========================================================================

/** 見本を作り直し、下ごしらえまで済ませる（AI は echo のまま） */
async function prepareCase(route) {
	await useBaseAi();
	writeFixtureSources();
	fs.rmSync(termsFile(), { force: true });
	fs.rmSync(tmxFile(), { force: true });
	await reload();
	await sync();
	if (route.prepare) await route.prepare();
}

/**
 * 1件（経路 × 意地悪）を試して、判定を積む。
 *
 * @returns {Promise<{requests:number, elapsed:number, result:object}>}
 */
async function runCase(route, nasty) {
	const phase = `${route.id}-${nasty.id}`;
	const file = route.watch[0];

	await prepareCase(route);
	const before = snapshotFixture();

	// 下ごしらえが狙った形になっているかを、意地悪を当てる前に確かめる。
	// ここが崩れていると、以下の判定は「別の場面」を見たことになる。
	const missing = route.precondition?.(before);
	if (missing)
		info(
			phase,
			route.watch[0],
			`下ごしらえが狙った形になっていない: ${missing}`,
			JSON.stringify(before[route.watch[0]] ?? "").slice(0, 300),
		);

	const script = path.join(SCENARIOS, nasty.id === "N1" ? RETRY_SCRIPT_BY_SHAPE[route.shape] : nasty.script);
	await useNastyAi(script, nasty.timeoutSec);

	const startedAt = Date.now();
	let result;
	try {
		result = await route.act();
	} catch (error) {
		result = { status: "error", error: String(error?.message ?? error), result: null, dialogs: [], logs: [] };
	}
	const elapsed = (Date.now() - startedAt) / 1000;
	const requests = nastyRequestCount();
	const after = snapshotFixture();

	say(
		`  ${phase} ${route.label} × ${nasty.label}` + ` → ${result.status} / ${elapsed.toFixed(1)}秒 / AIへ${requests}回`,
	);
	judge(phase, route, nasty, { before, after, result, elapsed, requests, file });

	stopNastyShim();
	return { requests, elapsed, result };
}

// ===========================================================================
// 判定
// ===========================================================================

/** 翻訳の結果らしきものから「成功したことになっているか」を読む */
function claimsSuccess(result) {
	const value = result?.result;
	if (!value || typeof value !== "object") return null;
	if (typeof value.translatedCount === "number") return value.translatedCount > 0;
	if (typeof value.successful === "number") return value.successful > 0;
	if (typeof value.newEntries === "number") return value.newEntries > 0;
	if (typeof value.newTerms === "number") return value.newTerms > 0;
	return null;
}

/** 応答の生テキストが本文へ入り込んでいないか（台本に書いた目印で探す） */
const RAW_FINGERPRINTS = ['{"translation"', '{"answer"', "力尽き", "これは訳文ではありません"];

function judge(phase, route, nasty, ctx) {
	const { before, after, result, elapsed, requests } = ctx;

	// --- どの意地悪でも共通に見ること ------------------------------------

	// (0) そもそも意地悪が当たったか。
	//     AI を1回も呼ばずに終わった場合、以下の判定はすべて「何もしていないから無傷」
	//     という当たり前のことしか言っていない。通ったことにしてはいけない。
	if (requests === 0) {
		info(
			phase,
			route.watch[0],
			`AI を1回も呼ばずに終わったので、この意地悪は当たっていない${route.blocked ? `（${route.blocked}）` : ""}`,
			`結果: ${JSON.stringify(result.result)}\n通知: ${JSON.stringify((result.dialogs ?? []).map((d) => d.message))}`,
		);
		return;
	}

	// (0.5) 途中で確認ダイアログが出て、lab が代わりに押していないか。
	//       押した結果として原稿が書き換わったなら、それは「勝手に壊した」のではなく
	//       「人が押したことにして進めた」ということ。この区別を落とすと騒ぎすぎになる。
	const pressed = (result.dialogs ?? []).filter((d) => d.answered && (d.buttons ?? []).length > 0);
	for (const dialog of pressed) {
		info(
			phase,
			route.watch[0],
			`途中で確認が出て、lab が「${dialog.answered}」と答えた`,
			`${dialog.message}\n選べたボタン: ${JSON.stringify(dialog.buttons)}\n※ 断る側を試すには MDAIT_LAB_DIALOG=no を付けてホストを起こし直す`,
		);
	}

	// (1) 原文は1バイトも変わってはいけない
	let sourceChanged = 0;
	for (const rel of Object.keys(before)) {
		if (!rel.startsWith("ja/")) continue;
		if (before[rel] !== after[rel]) {
			sourceChanged += 1;
			fail(phase, rel, "原文が書き換わった", diffHint(before[rel], after[rel]));
		}
	}
	if (sourceChanged === 0) ok(phase, "原文は無傷");

	// (2) マーカーは厳密文法から外れてはいけない
	let brokenMarkers = 0;
	for (const [rel, content] of Object.entries(after)) {
		if (rel.startsWith("@")) continue;
		for (const marker of markersOf(content)) {
			if (!MARKER_STRICT.exec(marker)) {
				brokenMarkers += 1;
				fail(phase, rel, "マーカーが厳密文法に不一致", marker);
			}
		}
	}
	if (brokenMarkers === 0) ok(phase, "マーカーの形は無事");

	// (3) 訳文のユニットが減っていない（章がまるごと消えていない）
	for (const rel of route.watch) {
		if (!rel.startsWith("en/")) continue;
		const wasMarkers = markersOf(before[rel] ?? "").length;
		const nowMarkers = markersOf(after[rel] ?? "").length;
		if (after[rel] === undefined) {
			fail(phase, rel, "訳文のファイルごと消えた", "");
		} else if (nowMarkers < wasMarkers) {
			fail(phase, rel, `訳文のユニットが減った（${wasMarkers} → ${nowMarkers}）`, after[rel].slice(0, 300));
		}
	}

	// (4) 台帳に幽霊の行（もう無いファイルを指す行）が残っていない
	const ghosts = ghostRows(after["@unit-state"] ?? "");
	if (ghosts.length > 0) {
		fail(phase, ".mdait/unit-state", `台帳に幽霊の行が ${ghosts.length} 件`, ghosts.slice(0, 3).join(" | "));
	}

	// --- 意地悪の型ごとに見ること ----------------------------------------

	if (nasty.kind === "ok") {
		// 送り直して完走するはず
		if (requests < 2) {
			info(phase, "-", `AI への往復が ${requests} 回で、送り直しが起きていない（経路が AI を呼んでいない可能性）`);
		} else if (elapsed < 1.5) {
			info(phase, "-", `送り直しはあったが ${elapsed.toFixed(1)} 秒しかかかっていない（待ち時間が入っていない）`);
		} else {
			ok(phase, `429/503 のあと送り直して ${elapsed.toFixed(1)} 秒で戻った（${requests} 往復）`);
		}
		if (result.status === "error") {
			fail(phase, route.watch[0], "一時的な失敗のあと送り直しても、コマンドが例外で終わった", String(result.error));
		} else {
			ok(phase, "コマンドは最後まで走った");
		}
		return;
	}

	if (nasty.kind === "clean-fail") {
		// きれいに失敗するはず（原稿はまったく変わらない）
		const touched = Object.keys(before).filter((rel) => !rel.startsWith("@") && before[rel] !== after[rel]);
		if (touched.length > 0) {
			fail(phase, touched[0], `失敗するはずの場面で原稿が ${touched.length} ファイル変わった`, touched.join(" | "));
		} else {
			ok(phase, "失敗しても原稿はまったく変わらなかった");
		}
		if (claimsSuccess(result) === true) {
			fail(phase, route.watch[0], "AI が一度も答えていないのに「できた」と報告した", JSON.stringify(result.result));
		}
		// 400 を送り直していないかは、往復の**数**では測れない。
		// フォルダ単位の経路はファイルを並列に処理するので、送り直しが1回も無くても
		// 往復はファイルの数だけ起きる（実測: 3ファイルで3回）。
		// 送り直しには必ず待ち時間（2秒→4秒→8秒）が入るので、**かかった時間**で見分ける。
		if (nasty.id === "N3") {
			if (elapsed > 1.5) {
				fail(
					phase,
					"-",
					`400 なのに送り直した（${requests} 往復・${elapsed.toFixed(1)}秒かかっている）`,
					"400 はこちらの出し方が悪いという返事なので送り直してはいけない。送り直しの待ち時間が入っている",
				);
			} else {
				ok(phase, `400 は送り直さずその場で失敗した（${requests} 往復・${elapsed.toFixed(1)}秒）`);
			}
		}
		if (nasty.id === "N2" && requests > 1) ok(phase, `500 は ${requests} 回まで送り直してから諦めた`);
		if (nasty.id === "N6") {
			if (elapsed > nasty.timeoutSec * 0.8) {
				ok(phase, `タイムアウトが効いた（${elapsed.toFixed(1)}秒）`);
			} else {
				// 相手は 20 秒黙る台本なのに、それより早く返ってきた。
				// つまりコマンドは AI の返事を待たずに戻っている（別の場所で走らせている）。
				// このとき、そのあと何が書かれるかはこの段取りからは見えない。
				info(
					phase,
					route.watch[0],
					`AI の返事を待たずに ${elapsed.toFixed(1)} 秒で戻った（この経路の後始末はここからは見えない）`,
					`相手は 20 秒黙る台本、mdait 側のタイムアウトは ${nasty.timeoutSec} 秒。往復 ${requests} 回`,
				);
			}
		}
		return;
	}

	// kind === "garbage" — 壊れた本文をどう扱ったか
	for (const rel of route.watch) {
		if (!rel.startsWith("en/")) continue;
		const was = before[rel] ?? "";
		const now = after[rel] ?? "";
		if (was === now) {
			ok(phase, `${rel} は変わらなかった（壊れた応答を採用しなかった）`);
			continue;
		}
		// 変わった → 何が入ったのか。
		// ここに1つも当てはまらなくても「変わった」ことは必ず残す。
		// 黙って通すと「壊れた応答を受けたのに何も言わなかった」ことになり、
		// あとから読む人が「無事だった」と読み違える。
		let named = 0;
		if (bodyOf(now).length === 0) {
			named += 1;
			fail(phase, rel, "訳文の本文が空になった", `前:\n${was}\n後:\n${now}`);
		}
		const dirty = RAW_FINGERPRINTS.find((mark) => now.includes(mark));
		if (dirty) {
			named += 1;
			fail(
				phase,
				rel,
				"壊れた応答の生テキストが本文に入った",
				`目印 "${dirty}" が本文にある。\n後:\n${now.slice(0, 400)}`,
			);
		}
		// frontmatter の値が空になっていないか（本文と同じで、消えたら元へは戻せない）
		for (const [key, was2, now2] of frontmatterPairs(was, now)) {
			if (was2.trim() !== "" && now2.trim() === "") {
				named += 1;
				fail(phase, rel, `frontmatter の ${key} が空になった`, `前:\n${was}\n後:\n${now}`);
			}
		}
		if (headingsOf(now) < headingsOf(was)) {
			named += 1;
			info(phase, rel, `見出しが ${headingsOf(was)} → ${headingsOf(now)} に減った`, now.slice(0, 300));
		}
		if (named === 0) {
			info(phase, rel, "壊れた応答のあとで訳文が変わった（本文が消えたわけではない）", `前:\n${was}\n後:\n${now}`);
		}
		// frontmatter のマーカーは本文のマーカーと別勘定にする。
		// まとめて数えると、本文がまだ need:translate のままであることに隠れて、
		// frontmatter の need だけが外れたことを見落とす（実測で見落とした）。
		const frontNeedWas = needFlag(frontMarker(was));
		const frontNeedNow = needFlag(frontMarker(now));
		if (frontNeedWas.startsWith("translate") && frontNeedNow === "" && was !== now) {
			fail(
				phase,
				rel,
				"frontmatter の訳が壊れているのに need が外れ、誰にも回されていない",
				`前: ${frontMarker(was)}\n後: ${frontMarker(now)}\n後の全文:\n${now.slice(0, 400)}`,
			);
		}

		// need フラグが宙に浮いていないか
		const wasNeeds = markersOf(was).map(needFlag).filter(Boolean);
		const nowNeeds = markersOf(now).map(needFlag).filter(Boolean);
		if (wasNeeds.some((n) => n.startsWith("translate")) && !nowNeeds.some((n) => n.startsWith("translate"))) {
			if (nowNeeds.some((n) => n.startsWith("review"))) {
				info(phase, rel, "訳せていないのに need:translate が外れたが、need:review が付いて人へ回された");
			} else {
				fail(phase, rel, "訳せていないのに need:translate が外れ、誰にも回されていない", now.slice(0, 300));
			}
		}
	}

	// 壊れた応答を受けたのに「できた」と報告していないか
	if (claimsSuccess(result) === true) {
		fail(
			phase,
			route.watch[0],
			"壊れた応答しか受けていないのに「翻訳できた」と報告した",
			`${JSON.stringify(result.result)}\n通知: ${JSON.stringify((result.dialogs ?? []).map((d) => d.message))}`,
		);
	} else if (claimsSuccess(result) === false) {
		ok(phase, "壊れた応答は採用せず、件数 0 として報告した");
	}

	// 用語集・翻訳メモリに、壊れた応答から作られた行が混ざっていないか
	for (const [key, label] of [
		["@terms.csv", "用語集"],
		["@translations.tmx", "翻訳メモリ"],
	]) {
		const was = before[key] ?? "";
		const now = after[key] ?? "";
		if (was === now) continue;
		const dirty = RAW_FINGERPRINTS.find((mark) => now.includes(mark));
		if (dirty) fail(phase, key, `${label} に壊れた応答の生テキストが書かれた`, now.slice(0, 300));
		else info(phase, key, `${label} が変わった（中身の確認は run ディレクトリの記録を見る）`, now.slice(0, 200));
	}
}

/**
 * frontmatter の同じ鍵どうしを並べて返す（[鍵, 前の値, 後の値] の並び）。
 * mdait 自身が書く `mdait:` の行は除く（マーカーであって原稿ではない）。
 */
function frontmatterPairs(was, now) {
	const parse = (text) => {
		const matched = /^---\n([\s\S]*?)\n---/.exec(text);
		const map = {};
		if (!matched) return map;
		for (const line of matched[1].split("\n")) {
			const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
			if (kv && kv[1] !== "mdait") map[kv[1]] = kv[2];
		}
		return map;
	};
	const before = parse(was);
	const after = parse(now);
	return Object.keys(before).map((key) => [key, before[key] ?? "", after[key] ?? ""]);
}

/** 台帳の中で、もう存在しないファイルを指す行 */
function ghostRows(unitState) {
	const rows = [];
	for (const line of unitState.split("\n")) {
		if (line.trim() === "" || line.startsWith("#")) continue;
		const cols = line.split("\t");
		if (cols.length !== 7) continue;
		if (!fs.existsSync(path.join(ws, cols[0]))) rows.push(line);
	}
	return rows;
}

/** 変わった場所を短く示す */
function diffHint(was, now) {
	return `前(${(was ?? "").length}文字):\n${(was ?? "").slice(0, 200)}\n後(${(now ?? "").length}文字):\n${(now ?? "").slice(0, 200)}`;
}

// ===========================================================================
// 入口
// ===========================================================================

/** `--only R1,R8` / `--nasty N1,N4` の書き方をそろえる */
function pickBy(list, only) {
	if (!only) return list;
	const wanted = String(only)
		.split(/[,\s]+/)
		.filter(Boolean)
		.map((token) => token.toUpperCase());
	return list.filter((entry) => wanted.includes(entry.id.toUpperCase()));
}

/**
 * 壊れた応答への耐性を1回まわす。
 *
 * 実験場（`lab up`）は既に立っている前提。下ごしらえには実験場の AI の相手（ふつう echo）を使い、
 * 意地悪のときだけ自分で shim を起こす。
 *
 * @param {{session?: object, verbose?: boolean, only?: string, nasty?: string}} options
 * @returns {Promise<{findings: Array<object>, failed: number}>}
 */
export async function run(options = {}) {
	const session = options.session ?? readSession();
	if (!session?.ws) throw new Error("実験場が立っていません。先に `lab up` を実行してください");
	if (session.host !== "headless") {
		say(`※ ホストが ${session.host} です。この段取りは headless を前提に作ってあります。`);
	}
	ws = session.ws;
	runDir = session.runDir ?? null;
	baseAi = session.ai ?? null;
	verbose = Boolean(options.verbose);
	findings = [];

	if (!baseAi?.baseURL) {
		say("※ 下ごしらえ用の AI の相手が立っていません。`lab up --ai echo` で始めてください。");
	}

	const routes = pickBy(ROUTES, options.only);
	const nasties = pickBy(NASTIES, options.nasty);
	say(`========== 壊れた応答への耐性（作業場 ${ws}） ==========`);
	say(`経路 ${routes.length} × 意地悪 ${nasties.length} = ${routes.length * nasties.length} 件を試します`);

	try {
		for (const route of routes) {
			say("");
			say(`--- ${route.id} ${route.label} ---`);
			for (const nasty of nasties) {
				try {
					await runCase(route, nasty);
				} catch (error) {
					fail(`${route.id}-${nasty.id}`, "-", "試している途中で止まった", String(error?.stack ?? error));
					stopNastyShim();
				}
			}
		}
	} finally {
		// 意地悪の相手を残したまま帰らない。設定も実験場の相手へ戻す
		try {
			await useBaseAi();
		} catch {
			stopNastyShim();
		}
	}

	const failed = findings.filter((f) => f.sev === "FAIL");
	const infos = findings.filter((f) => f.sev === "INFO");
	say("");
	say("========== まとめ ==========");
	say(`FAIL=${failed.length} INFO=${infos.length} OK=${findings.filter((f) => f.sev === "OK").length}`);
	for (const finding of infos) {
		say(`  INFO (${finding.phase}) ${finding.file}: ${finding.summary}`);
		if (verbose && finding.detail) say(`         ${String(finding.detail).split("\n").join("\n         ")}`);
	}
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
		say("使い方: node scripts/lab/scenarios/resilience.mjs [--only R1,R8] [--nasty N1,N4] [--verbose] [--keep]");
		say("");
		say("経路:");
		for (const route of ROUTES) say(`  ${route.id}  ${route.label}`);
		say("意地悪:");
		for (const nasty of NASTIES) say(`  ${nasty.id}  ${nasty.label}（${nasty.why}）`);
		return 0;
	}
	let session = readSession();
	let startedHere = false;
	if (!session?.hostPid || !alive(session.hostPid)) {
		say("実験場が立っていないので、既定（headless + echo + 使い捨ての作業場）で始めます。");
		await runLab(["up", "--host", "headless", "--ai", "echo", "--ws", "tmp", "--reset", "--name", "resilience"]);
		session = readSession();
		startedHere = true;
	}
	const { failed } = await run({
		session,
		verbose: Boolean(opts.verbose),
		only: opts.only,
		nasty: opts.nasty,
	});
	if (startedHere && !opts.keep) await runLab(["down"]);
	return failed > 0 ? 1 : 0;
}

// 直に動かしたときだけ入口を開く
const invokedDirectly = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
	main()
		.then((code) => process.exit(code))
		.catch((error) => {
			process.stderr.write(`${error?.stack ?? error}\n`);
			process.exit(1);
		});
}
