#!/usr/bin/env node
import { spawn } from "node:child_process";
/*
 * mdait-lab — mdait の動きを実際に走らせて確かめるための入口。
 *
 * 考え方は3つだけ。
 *   1. 入口は1つ。やることは「動詞」で言う（up / run / status / down …）。
 *   2. 命令はどのホストでも同じ道（ファイル）を通る。ホストの違いは hosts/ の中に閉じる。
 *   3. 画面に出すのは要約だけ。全文は run ディレクトリに残す。
 *
 * 詳しくは `node scripts/lab/lab.mjs --help`。
 */
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { COMMANDS } from "./hosts/registry.mjs";
import { UsageError, asNumber, oneOf, parseArgs } from "./lib/args.mjs";
import { summarizeResult } from "./lib/digest.mjs";
import { ipcPaths, sendCommand } from "./lib/ipc.mjs";
import { buildReport, createRun, saveStep, snapshotBaseline } from "./lib/runs.mjs";
import { LAB_DIR, clearSession, ensureLabDir, readSession, writeSession } from "./lib/session.mjs";
import { buildSite, compareDigests } from "./lib/site-hugo.mjs";
import { DEFAULT_SITE_DIR, generateSite } from "./lib/site.mjs";
import { configureAi, prepareWorkspace, restoreConfig } from "./lib/workspace.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const AI_DIR = path.join(HERE, "ai");
const SHIM = path.join(AI_DIR, "shim.mjs");

const HOSTS = ["headless", "code-server", "desktop"];
const AI_MODES = ["echo", "live", "agent", "script", "replay", "none"];

const BOOLEANS = [
	"reset",
	"json",
	"help",
	"quiet",
	"dry",
	"verbose",
	"keep",
	"time",
	"no-diff",
	"script-loop",
	"self-test",
];

const HELP = `mdait-lab — mdait を実際に走らせて確かめる実験場

  node scripts/lab/lab.mjs <動詞> [引数...]

まず何をする道具か
  mdait のコマンド（同期・翻訳・用語集・翻訳メモリ…）を、使い捨ての作業場に対して
  本当に走らせます。翻訳の相手（AI）も選べます。決まった訳文を返す偽物、自分で答える
  郵便受け、録音の再生、claude を翻訳役に立てる、など。
  結果は run ディレクトリに全文が残り、画面には要約だけが出ます。

動詞
  up      実験を始める。作業場を用意し、AI の相手を立て、ホストを常駐させる
            --host <headless|code-server|desktop>  どこで動かすか（既定: headless）
            --ai   <echo|live|agent|script|replay|none>  誰が訳すか（既定: echo）
            --ws   <tmp|repo|パス>   作業場（既定: tmp = ${path.join(LAB_DIR, "ws")}）
            --reset                   作業場を見本から作り直す
            --name <名前>             run ディレクトリに付ける名前
            --delay <ミリ秒>          echo が答えるまで待つ時間（遅さの再現）
            --script <ファイル>       script モードの台本
            --script-loop             台本を使い切ったら先頭へ戻す（無いと 409 で止まる）
            --replay <ファイル>       replay モードの録音
            --record <ファイル>       やり取りを録音する
            --agent-model <モデル>    agent モードで翻訳役に立てる claude のモデル
            --agent-command <コマンド> 翻訳役として起こすコマンド（既定 claude）
  run     mdait のコマンドを1つ実行する（up していなければ既定で自動的に始める）
            node scripts/lab/lab.mjs run mdait.sync
            node scripts/lab/lab.mjs run mdait.trans content/en/10_test.md
            （パスは作業場から見た相対でよい。翻訳系は「訳文の側」のファイルを渡す）
            --json                    要約でなく result.json をそのまま出す
            --timeout <秒>            待つ上限（既定: 600）
  shot    画面を撮る（code-server ホストのときだけ）
            node scripts/lab/lab.mjs shot 初期状態
  ai      AI の相手とやり取りする
            ai wait     次の質問が来るまで待つ（live モード）
            ai digest   直近の質問の要約を読む
            ai reply --translation "訳文"   答えを返す
            ai stats    何件受けたかを見る
            ai last     直近の質問の全文を見る
  cancel  走っている最中のコマンドに「やめてくれ」と伝える（headless ホストのみ）
            別のシェルから叩く。中断からの再開を確かめるときに使う
  status  いまの様子と直近の手順を出す
  reset   作業場を見本から作り直す（ホストは止めない）
  site    規模のある見本サイトを書き出す（取り込みを実運用に近い数で走らせるため）
            --out <パス>              置き場（既定: ${DEFAULT_SITE_DIR}）
            --markers <embedded|external>  マーカーの置き場（既定: embedded）
            そのあと --ws <パス> で作業場として指す:
              node scripts/lab/lab.mjs site --markers external
              node scripts/lab/lab.mjs up --ws ${DEFAULT_SITE_DIR} --ai agent --agent-model haiku
  hugo    見本サイトを静的サイトジェネレータで建て、通るかを見る（Hugo が要る）
            --ws <パス>      建てる場所（既定: ${DEFAULT_SITE_DIR}）
            --save <ファイル>    出力の指紋を残す（取り込みの前に取る）
            --baseline <ファイル> 残した指紋と比べ、増減と変化したページを出す
            Hugo は PATH か MDAIT_HUGO_BIN から探す。無ければ「試せなかった」として素通りする
  report  run ディレクトリから report.md を組み立てて場所を出す
  down    ホストと AI の相手を止め、退避した設定を戻す

ひとまとめの段取り（低レベルな動詞の組み合わせ。独自の実装は持ちません）
  sweep    決定的スイープ（旧 npm run test:explore）。FAIL があれば終了コード 1
            --only P1,P5   段を絞る    --verbose 通った判定も出す    --keep 終わっても止めない
  probe    頑健性プローブ（旧 probe-robustness）。判定せず観察し、前回の run と比べる
            --only S3,S13  シナリオを絞る    --diff <runのパス>  比べる相手    --time 所要時間も出す
  regress  録音の再生（旧 npm run test:byok:e2e）。食い違えば終了コード 1
            --replay <ファイル>  別の録音を再生する
  resilience  壊れた応答への耐性（429・500・途中で切れた JSON・長い沈黙など）
            --only R1,R8   経路を絞る    --nasty N1,N4  意地悪を絞る
            **1周は20〜30分かかる。CI には入れていない**
  prompt   指示文の比べ読み（未実装。組み立て方だけ出ます）
  bench-revise  改訂（revise）の出力形式を比べて数える。どこで落ちたかが段ごとに出る
            --self-test    LLM を呼ばずに判定の筋道だけ確かめる（実費ゼロ）
            --model <名前> 翻訳役のモデル（既定 haiku）  --base-url <URL> 自前の OpenAI 互換の行き先
            --cases C1,C4  --variants current,linenum  --repeat <回数>
            --response-format <off|json_object|json_schema>  JSON の封筒を使う候補にだけ
                           response_format を付ける。**claude 経由では捨てられる**ので、
                           効き目は自前の OpenAI 互換の口を --base-url で指したときだけ測れる
  ux       実 UI にしか無いもの（ツリーのアイコン・確認ダイアログ・翻訳中の回転・CodeLens・通知）を
           ブラウザ版 VS Code で撮り、文字にも落とす。**設営に数分・CI 対象外**
            --only U1,U4   段を絞る    --keep 終わっても止めない

  どの段取りも --dry を付けると、実行せずに「実際には何をしているのか」だけを出します。

はじめの一歩
  node scripts/lab/lab.mjs up --host headless --ai none --ws tmp --reset
  node scripts/lab/lab.mjs run mdait.sync
  node scripts/lab/lab.mjs status
  node scripts/lab/lab.mjs down

覚えておくこと
  - 作業場は既定で ${path.join(LAB_DIR, "ws")}。リポジトリの中は既定にしません
    （--ws repo を選んだときだけ使い、設定は必ず退避して down で戻します）
  - 置き場所は環境変数 MDAIT_LAB_DIR で変えられます（既定 /tmp/mdait-lab）
  - 走らせる前に npm run compile が要ります（out/ の中身を直に呼ぶため）
`;

// ===========================================================================
// 画面への出し方
// ===========================================================================

function say(text = "") {
	process.stdout.write(`${text}\n`);
}

function warn(text) {
	process.stderr.write(`${text}\n`);
}

/**
 * 走り出す前に、前提が揃っているかだけ見る。
 *
 * 揃っていないと `Cannot find module '.../out/...'` という、原因が読み取れない形で落ちる
 * （実測: `out/` が無いだけで headless の起動が謎の module not found になる）。
 * 落ちる前に「何が無くて、どう直すか」を1行で言う。
 */
function preflight() {
	const missing = [];
	if (!fs.existsSync(path.join(REPO, "node_modules"))) {
		missing.push("依存が入っていません（node_modules がありません） → `npm ci`");
	}
	if (!fs.existsSync(path.join(REPO, "out", "commands"))) {
		missing.push("まだコンパイルされていません（out/commands がありません） → `npm run compile`");
	}
	if (missing.length > 0) {
		throw new UsageError(`実験場を起こす前に、次を済ませてください:\n  - ${missing.join("\n  - ")}`);
	}
}

/** ホストごとの実装を読み込む */
async function loadHost(name) {
	const file = path.join(HERE, "hosts", `${name}.mjs`);
	if (!fs.existsSync(file)) {
		throw new UsageError(`ホスト ${name} はまだ用意されていません（${file} がありません）`);
	}
	return await import(file);
}

/** いま動いているセッションを取り出す。無ければ null */
function liveSession() {
	const session = readSession();
	if (!session) return null;
	if (session.hostPid && !alive(session.hostPid)) return { ...session, hostDead: true };
	return session;
}

function alive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

// ===========================================================================
// AI の相手（shim）を独立したプロセスとして立てる
// ===========================================================================

/**
 * shim を起こしてポートを聞き取る。
 * まだ scripts/lab/ai/shim.mjs が無い場合は、止まらずに「無い」と伝えて null を返す。
 */
async function startShim(mode, options) {
	if (mode === "none") return null;
	if (!fs.existsSync(SHIM)) {
		warn(`AI の相手（${SHIM}）がまだありません。AI を使うコマンドは動きません。`);
		warn("  → AI を使わない sync などは、このまま試せます。--ai none を付ければこの知らせは出ません。");
		return { mode, missing: true };
	}
	ensureLabDir();
	const logFile = path.join(LAB_DIR, "ai-shim.log");
	fs.writeFileSync(logFile, "", "utf8");
	const argv = ["--mode", mode, "--port", "0"];
	if (options.delay !== undefined) argv.push("--delay", String(options.delay));
	if (options.script) argv.push("--script", path.resolve(options.script));
	// 台本を使い切ったら先頭へ戻す。無いと、ユニット数が台本の数を超えた時点で 409 で止まる
	if (options.scriptLoop) argv.push("--script-loop");
	if (options.replay) argv.push("--replay", path.resolve(options.replay));
	if (options.record) argv.push("--record", path.resolve(options.record));
	// agent モードで翻訳役に立てる claude の中身。指示文を比べるときは弱い段（haiku）を選ぶ
	if (options.agentModel) argv.push("--agent-model", options.agentModel);
	if (options.agentCommand) argv.push("--agent-command", options.agentCommand);
	const mailbox = path.join(LAB_DIR, "mailbox");
	argv.push("--mailbox", mailbox);

	const fd = fs.openSync(logFile, "a");
	const child = spawn(process.execPath, [SHIM, ...argv], {
		cwd: path.resolve(HERE, "..", ".."),
		detached: true,
		stdio: ["ignore", fd, fd],
		env: { ...process.env, MDAIT_LAB_DIR: LAB_DIR },
	});
	child.unref();

	// 立ち上がると標準出力の1行目に PORT=<番号> が出る。ログ越しに拾う
	const limit = Date.now() + 30_000;
	while (Date.now() < limit) {
		const text = fs.readFileSync(logFile, "utf8");
		const match = /^PORT=(\d+)/m.exec(text);
		if (match) {
			const port = Number(match[1]);
			return {
				mode,
				port,
				pid: child.pid,
				baseURL: `http://127.0.0.1:${port}/v1`,
				record: options.record ? path.resolve(options.record) : null,
				mailbox,
				logFile,
			};
		}
		if (child.exitCode !== null) {
			throw new Error(`AI の相手が立ち上がりませんでした（終了コード ${child.exitCode}）。${logFile} を見てください`);
		}
		await sleep(150);
	}
	throw new Error(`AI の相手が 30 秒たっても名乗りませんでした。${logFile} を見てください`);
}

function stopShim(session) {
	const pid = session?.ai?.pid;
	if (!pid || !alive(pid)) return false;
	// 名前で探して落とすと自分のシェルまで巻き込む。必ず番号で止める
	try {
		process.kill(pid, "SIGTERM");
	} catch {}
	return true;
}

// ===========================================================================
// 動詞
// ===========================================================================

async function verbUp(opts) {
	const existing = liveSession();
	if (existing && !existing.hostDead) {
		say("すでに動いています。作り直すときは先に `lab down` を実行してください。");
		say(await describe(existing));
		return 0;
	}
	if (existing?.hostDead) {
		say("前のホストはもういないので、記録を捨ててやり直します。");
		clearSession();
	}
	// 新しく起こすときだけ見る。動いているものの様子を聞かれただけなら邪魔をしない
	preflight();

	const host = oneOf(opts.host, HOSTS, "--host") ?? "headless";
	const aiMode = oneOf(opts.ai, AI_MODES, "--ai") ?? "echo";
	const wsMode = opts.ws ?? "tmp";
	const reset = Boolean(opts.reset);

	const ws = await prepareWorkspace({ mode: wsMode, reset });
	say(`作業場: ${ws}${reset ? "（見本から作り直しました）" : ""}`);

	const ai = await startShim(aiMode, {
		delay: opts.delay,
		script: opts.script,
		scriptLoop: opts["script-loop"],
		replay: opts.replay,
		record: opts.record,
		agentModel: opts["agent-model"],
		agentCommand: opts["agent-command"],
	});
	if (ai?.baseURL) {
		configureAi(ws, { mode: aiMode, baseURL: ai.baseURL, model: opts.model, timeoutSec: asNumber(opts.timeout, 600) });
		say(`AI の相手: ${aiMode}（${ai.baseURL} / pid ${ai.pid}）`);
	} else if (aiMode === "none") {
		say("AI の相手: 立てません（mdait.json の ai 設定に触りません）");
	}

	const hostModule = await loadHost(host);
	const started = await hostModule.up({ ws, ai, logLevel: opts["log-level"] });
	say(`ホスト: ${host}（pid ${started.pid}${started.port ? ` / ポート ${started.port}` : ""}）`);

	const { runDir } = createRun(opts.name ?? host);
	const session = {
		host,
		hostPid: started.pid,
		hostPort: started.port ?? null,
		// 画面を開いたままにしておく常駐ページ（code-server のときだけ）。
		// これがいないと Extension Host ごと畳まれ、IPC に返事が来なくなる
		browserPid: started.browserPid ?? null,
		browserWs: started.browserWs ?? null,
		ws,
		wsMode,
		ai: ai ?? { mode: "none" },
		runDir,
		startedAt: new Date().toISOString(),
	};
	writeSession(session);
	fs.writeFileSync(path.join(runDir, "session.json"), `${JSON.stringify(session, null, 2)}\n`, "utf8");
	snapshotBaseline(runDir, ws);
	say(`記録の置き場: ${runDir}`);
	return 0;
}

/** run が呼ばれたときに、まだ始まっていなければ既定の形で始める */
async function ensureUp() {
	const session = liveSession();
	if (session && !session.hostDead) return session;
	if (session?.hostDead) clearSession();
	say("まだ始まっていないので、既定（--host headless --ai echo --ws tmp）で始めます。");
	await verbUp({ host: "headless", ai: "echo", ws: "tmp" });
	return readSession();
}

/** コマンドを1つ実行して、結果と終了コードの両方を返す */
async function runOne(opts) {
	const command = opts._[0];
	if (!command) throw new UsageError("実行するコマンド名が要ります（例: lab run mdait.sync）");
	if (!command.startsWith("mdait.")) throw new UsageError(`コマンド名は mdait. で始まります（渡された値: ${command}）`);

	const session = await ensureUp();
	const entry = COMMANDS[command];
	if (entry && !entry.hosts.includes(session.host)) {
		warn(`※ ${command} は ${session.host} では動きません: ${entry.note}`);
	}
	if (entry?.asksUser && session.host === "headless") {
		warn(`※ ${command} は途中で確認を出します。headless では誰も答えないので、何もせず戻ることがあります。`);
	}

	const args = resolvePathArgs(entry, opts._.slice(1).map(parseArgValue), session.ws);
	const result = await sendCommand(session.ws, command, args, { timeoutSec: asNumber(opts.timeout, 600) });

	// 実ホストでは、画面を見張っている常駐ページがダイアログや通知に答えている。
	// その控えを結果に合流させて、headless と同じ形（result.dialogs）で読めるようにする。
	if (session.host === "code-server") {
		try {
			const { drainDialogs } = await import(path.join(HERE, "ui", "driver.mjs"));
			const dialogs = await drainDialogs();
			if (dialogs.length > 0) result.dialogs = [...(result.dialogs ?? []), ...dialogs];
		} catch {
			// 常駐ページがいなければ控えも無い。結果の扱いは変えない
		}
	}

	if (opts.json) {
		say(JSON.stringify(result, null, 2));
		return { result, code: result.status === "error" ? 1 : 0 };
	}

	const step = saveStep(session.runDir, command, result, { args, ws: session.ws });
	say(step.digest.trimEnd());
	return { result, code: result.status === "error" ? 1 : 0 };
}

/** 動詞としての run。終了コードだけを返す（中身が要る場面は runOne を直に呼ぶ） */
async function verbRun(opts) {
	const { code } = await runOne(opts);
	return code;
}

/**
 * `{...}` や `[...]` の形で書かれた引数を、そのまま JSON として読む。
 *
 * `lab run mdait.sync '{"adopt":true}'` のように書けることを文書で約束しているのに、
 * 文字列のまま渡していた（実測: `options?.adopt` が偽になり、取り込みが起きないまま
 * `done` / `totalAdopted:0` で終わる。**起きなかったことが結果から見分けられない**）。
 * 読めない形はそのまま文字列として渡す（パスや普通の語を壊さないため）。
 */
function parseArgValue(value) {
	if (typeof value !== "string") return value;
	const trimmed = value.trim();
	if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return value;
	try {
		return JSON.parse(trimmed);
	} catch {
		return value;
	}
}

/**
 * 1つ目の引数がパスを取るコマンドなら、相対の書き方を作業場から見た絶対パスに直す。
 * `content/ja/10_test.md` のように打てるようにするため（打った場所によって意味が変わらない）。
 */
function resolvePathArgs(entry, args, ws) {
	const takesPath = ["uri", "file-item", "dir-item", "auto-item"];
	if (!entry || !takesPath.includes(entry.args)) return args;
	if (args.length === 0 || typeof args[0] !== "string" || path.isAbsolute(args[0])) return args;
	return [path.resolve(ws, args[0]), ...args.slice(1)];
}

/**
 * 走っている最中のコマンドを止める。
 *
 * 実 VS Code なら進捗の通知の「取り消し」を押すところ。画面の無い headless では
 * 目印のファイルを置いて伝える（読む側は vscode-shim.js の withProgress）。
 * 依頼を出すたびに目印は消えるので、次の実行に持ち越されることはない。
 */
function verbCancel() {
	const session = liveSession();
	if (!session) throw new UsageError("まだ始まっていません。止める相手がいません");
	if (session.host !== "headless") {
		throw new UsageError(
			`中断を送れるのは headless ホストのときだけです（いまは ${session.host}）。` +
				"実 VS Code では進捗の通知に付く「取り消し」を押してください",
		);
	}
	const { dir, cancelFile } = ipcPaths(session.ws);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(cancelFile, `${new Date().toISOString()}\n`, "utf8");
	say("中断を伝えました。コマンドは次の節目で止まります。");
	say(`  目印: ${cancelFile}（次の依頼で自動的に消えます）`);
	return 0;
}

async function verbShot(opts) {
	const name = opts._[0] ?? "shot";
	const session = liveSession();
	if (!session) throw new UsageError("まだ始まっていません。先に `lab up --host code-server` を実行してください");
	if (session.host !== "code-server") {
		throw new UsageError(`画面を撮れるのは code-server ホストのときだけです（いまは ${session.host}）`);
	}
	const driver = path.join(HERE, "ui", "driver.mjs");
	if (!fs.existsSync(driver)) {
		warn(`画面を操る道具（${driver}）がまだありません。用意され次第この動詞が使えるようになります。`);
		return 2;
	}
	const { shot } = await import(driver);
	const file = await shot(session, name);
	say(`撮りました: ${file}`);
	return 0;
}

async function verbAi(opts) {
	const what = opts._[0];
	const session = liveSession();
	const ai = session?.ai;
	if (!ai || ai.mode === "none")
		throw new UsageError("AI の相手が立っていません（`lab up --ai echo` などで始めてください）");
	if (ai.missing) throw new UsageError("AI の相手（scripts/lab/ai/shim.mjs）がまだありません");
	const mailbox = ai.mailbox ?? path.join(LAB_DIR, "mailbox");

	switch (what) {
		case "wait":
			return await runNode(path.join(AI_DIR, "wait.mjs"), ["--mailbox", mailbox]);
		case "reply": {
			const argv = ["--next", "--mailbox", mailbox];
			if (opts.translation !== undefined) argv.push("--translation", String(opts.translation));
			else if (opts.text !== undefined) argv.push("--text", String(opts.text));
			else throw new UsageError("--translation か --text のどちらかが要ります");
			return await runNode(path.join(AI_DIR, "reply.mjs"), argv);
		}
		case "digest":
			return showNewest(mailbox, /^digest-\d+\.md$/, "要約");
		case "last":
			return showNewest(mailbox, /^req-\d+\.json$/, "直近の質問");
		case "stats": {
			const origin = ai.baseURL.replace(/\/v1\/?$/, "");
			const response = await fetch(`${origin}/__shim/stats`);
			say(JSON.stringify(await response.json(), null, 2));
			return 0;
		}
		default:
			throw new UsageError("ai のあとは wait / digest / reply / stats / last のどれかです");
	}
}

/** 郵便受けの中でいちばん新しいものを出す */
function showNewest(mailbox, pattern, label) {
	let names = [];
	try {
		names = fs
			.readdirSync(mailbox)
			.filter((n) => pattern.test(n))
			.sort();
	} catch {}
	if (names.length === 0) {
		say(`${label}はまだありません（${mailbox}）`);
		return 0;
	}
	const file = path.join(mailbox, names[names.length - 1]);
	say(`--- ${file} ---`);
	say(fs.readFileSync(file, "utf8").trimEnd());
	return 0;
}

/** 別のスクリプトを前面で走らせ、その終了コードをそのまま返す */
function runNode(file, argv) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [file, ...argv], {
			stdio: "inherit",
			env: { ...process.env, MDAIT_LAB_DIR: LAB_DIR },
		});
		child.on("exit", (code) => resolve(code ?? 0));
	});
}

async function describe(session) {
	const lines = [];
	lines.push(`ホスト: ${session.host}（pid ${session.hostPid}${session.hostDead ? " — もういません" : ""}）`);
	lines.push(`作業場: ${session.ws}`);
	lines.push(`AI の相手: ${session.ai?.mode ?? "none"}${session.ai?.baseURL ? `（${session.ai.baseURL}）` : ""}`);
	lines.push(`記録: ${session.runDir}`);
	try {
		const hostModule = await loadHost(session.host);
		lines.push(await hostModule.status(session));
	} catch (error) {
		lines.push(`ホストの様子は分かりません: ${error.message}`);
	}
	return lines.join("\n");
}

async function verbStatus() {
	const session = liveSession();
	if (!session) {
		say("まだ何も始まっていません。`lab up` から始めてください。");
		return 0;
	}
	say(await describe(session));

	// 直近の手順を1つだけ短く
	let names = [];
	try {
		names = fs
			.readdirSync(path.join(session.runDir, "steps"))
			.filter((n) => n.endsWith(".json"))
			.sort();
	} catch {}
	if (names.length === 0) {
		say("手順はまだありません。");
		return 0;
	}
	const last = path.join(session.runDir, "steps", names[names.length - 1]);
	const result = JSON.parse(fs.readFileSync(last, "utf8"));
	const s = summarizeResult(result);
	say("");
	say(`直近の手順: ${result.command} → ${s.status}${s.durationSec ? `（${s.durationSec} 秒）` : ""}`);
	say(`  気になるログ ${s.notable.length} 行 / 全 ${s.logCount} 行`);
	say(`  全文: ${last}`);
	return 0;
}

async function verbReset(opts) {
	const session = liveSession();
	const wsMode = opts.ws ?? session?.wsMode ?? "tmp";
	const ws = await prepareWorkspace({ mode: wsMode, reset: true });
	say(`作業場を見本から作り直しました: ${ws}`);

	// 設定は雛形に戻るので、AI の相手への差し向けも付け直す
	if (session?.ai?.baseURL) {
		configureAi(ws, { mode: session.ai.mode, baseURL: session.ai.baseURL });
		say(`AI の相手への差し向けを付け直しました（${session.ai.baseURL}）`);
	}

	// ホストは前の中身を覚えたままなので、捨てて読み直してもらう
	// （実 VS Code のホストは mdait. で始まらない命令を受け付けないので、そちらは窓を開き直してもらう）
	if (session && !session.hostDead && session.host !== "headless") {
		say(`${session.host} は前の中身を覚えたままです。VS Code の窓を開き直してから続けてください。`);
		return 0;
	}
	if (session && !session.hostDead) {
		try {
			await sendCommand(ws, "lab.reload", [], { timeoutSec: 60 });
			say("ホストにも読み直してもらいました。続けてそのまま `lab run` できます。");
		} catch (error) {
			warn(`ホストの読み直しに失敗しました: ${error.message}`);
			warn("  → 一度 `lab down` してから `lab up` し直してください。");
			return 1;
		}
	}
	return 0;
}

async function verbReport() {
	const session = liveSession();
	if (!session) throw new UsageError("まだ始まっていません");
	const file = buildReport(session.runDir);
	say(`まとめました: ${file}`);
	const text = fs.readFileSync(file, "utf8");
	say("");
	say(text.split("\n").slice(0, 40).join("\n"));
	return 0;
}

async function verbDown() {
	const session = readSession();
	if (!session) {
		say("止めるものがありません。");
		return 0;
	}
	try {
		const hostModule = await loadHost(session.host);
		// ホストによっては何も返さない。返事が無くても止まったものとして扱う
		const result = (await hostModule.down(session)) ?? { stopped: true };
		say(
			result.stopped
				? `ホストを止めました（pid ${result.pid ?? session.hostPid}${result.forced ? " — 強く止めました" : ""}）`
				: `ホスト: ${result.reason}`,
		);
	} catch (error) {
		warn(`ホストを止められませんでした: ${error.message}`);
	}
	if (stopShim(session)) say(`AI の相手を止めました（pid ${session.ai.pid}）`);

	// リポジトリ内など、退避してある設定は必ず戻す
	if (session.ws && restoreConfig(session.ws)) say("退避しておいた mdait.json を戻しました。");

	// やり取りの合図を片付ける
	try {
		const paths = ipcPaths(session.ws);
		for (const file of [paths.readyFile, paths.commandFile, paths.resultFile, paths.enableFile]) {
			fs.rmSync(file, { force: true });
		}
	} catch {}

	if (session.runDir) {
		try {
			say(`記録をまとめました: ${buildReport(session.runDir)}`);
		} catch {}
	}
	clearSession();
	return 0;
}

// ===========================================================================
// ひとまとめの段取り
// ===========================================================================

/**
 * 段取りは「低レベルな動詞の組み立て」としてだけ書く。**独自の実装を持たせない。**
 * ここに手続きを書き足したくなったら、それは動詞かシナリオのどちらかに属する仕事である。
 * steps は「実際には何をしているのか」を人に見せるためのもので、--dry を付けると実行せずに出す。
 */
const PRESETS = {
	sweep: {
		run: presetSweep,
		note: "決定的スイープ（旧 npm run test:explore）。うまくいかなければ終了コード 1",
		steps: [
			"lab up --host headless --ai echo --ws tmp --reset --name sweep",
			"lab run mdait.sync を2回（2回目で何も変わらないことを見る）",
			"lab run mdait.trans <訳文ファイル>（need:translate が消えることを見る）",
			"原文を書き換えてから lab run mdait.sync（need:revise が付くことを見る）",
			"lab report ／ lab down",
		],
	},
	probe: {
		run: presetProbe,
		note: "頑健性プローブ（旧 probe-robustness）。前回の run との差を出す",
		steps: [
			"lab up --host headless --ai echo --ws tmp --reset --name probe",
			"編集・章の入れ替え・リネーム・フォルダ移動などを順に加えて lab run mdait.sync",
			"埋め込みマーカーと外部マーカーの両方で同じ手順を流す",
			"lab report（前回の run の棚卸しと並べる）",
		],
	},
	regress: {
		run: presetRegress,
		note: "録音の再生（旧 npm run test:byok:e2e）。食い違えば終了コード 1",
		steps: [
			"lab up --host headless --ai replay --replay scripts/lab/ai/recordings/trans-en-child.jsonl --ws tmp --reset",
			"lab run mdait.translate.directory content/en/child",
			"lab report ／ lab down",
		],
	},
	resilience: {
		run: presetResilience,
		note: "壊れた応答への耐性。AI を使う9経路に8種の意地悪を当て、原稿が壊れないかを見る",
		steps: [
			"lab up --host headless --ai echo --ws tmp --reset --name resilience",
			"経路ごとに見本を作り直し、意地悪な台本の受け皿を --script-loop 付きで起こす",
			"コマンドを1つ叩き、前後のファイル・マーカー・台帳・用語集・翻訳メモリを突き合わせる",
			"lab report ／ lab down",
		],
	},
	prompt: {
		note: "指示文の比べ読み。claude を翻訳役に立てて同じ原稿を訳し、録音を見比べる",
		steps: [
			"lab up --host headless --ai agent --ws tmp --reset --record <録音先>",
			"lab run mdait.translate.directory <対象フォルダ>",
			"lab ai last ／ lab report",
		],
	},
	"bench-revise": {
		run: presetBenchRevise,
		note: "改訂の出力形式を比べる。同じケースを候補ごとに投げ、どの段で落ちたかを数える",
		steps: [
			"（--base-url が無ければ）AI の受け皿を agent モードで立て、claude を翻訳役にする",
			"ケース（原文の旧版・新版・前回訳文）× 候補（出力形式）の全組を組み立てる",
			"1件ずつ OpenAI 互換の口へ投げ、transport → envelope → format → apply → health の順に判定する",
			"候補ごとの成立数と、落ちた段の内訳を表にする（全文は run ディレクトリの bench-revise.json）",
		],
	},
	ux: {
		run: presetUx,
		note: "実 UI でしか見えないもの（ツリーのアイコン・CodeLens・確認ダイアログ）を撮って文字に落とす",
		steps: [
			"lab up --host code-server --ai echo --delay 4000 --ws tmp --reset --name ux",
			"lab run mdait.sync → ツリーの行とアイコンを読む（U1）",
			"lab run mdait.translate.directory を出しっぱなしにして、立ちはだかる確認を撮る（U2）",
			"走っている最中のツリーを繰り返し読み、回転アイコンを捉える（U3）",
			"訳文と原文を開いて CodeLens のボタンを読む（U4）／通知の文言を拾う（U5）",
			"lab report ／ lab down",
		],
	},
};

async function runPreset(name, opts) {
	const preset = PRESETS[name];
	if (opts.dry || !preset.run) {
		if (!preset.run) say(`「${name}」はまだ中身が入っていません。組み立て方だけ出します。`);
		say(`  ねらい: ${preset.note}`);
		say("  組み立て方（低レベルな動詞の並び）:");
		for (const step of preset.steps) say(`    ${step}`);
		return preset.run ? 0 : 2;
	}
	return await preset.run(opts);
}

/**
 * 段取り（sweep / probe / resilience）は既定の作業場（tmp）の原稿を前提に判定する。
 * ほかの作業場を指したセッションが立ったままだと、**別の原稿に対して黙って判定が走り**、
 * 読み手には原因の分からない例外だけが出る（実測: 見本サイトを指したまま sweep を回して
 * phase4 が readFileSync で落ちた）。立ち上げ直しは勝手にせず、何が起きているかを言って止める。
 */
function requireTmpWorkspace(name) {
	const session = liveSession();
	if (!session) return true;
	if (session.wsMode === undefined || session.wsMode === "tmp") return true;
	warn(`いま立っている作業場は ${session.ws}（--ws ${session.wsMode}）です。`);
	warn(`${name} は既定の作業場（tmp）の原稿で判定するので、このままでは別の原稿を測ってしまいます。`);
	warn("片付けてから回し直してください: node scripts/lab/lab.mjs down");
	return false;
}

/** スイープ（決定的な総なめ）。判定は scenarios/sweep.mjs が持つ */
async function presetSweep(opts) {
	if (!requireTmpWorkspace("sweep")) return 2;
	if (!liveSession()) await verbUp({ host: "headless", ai: "echo", ws: "tmp", reset: true, name: "sweep" });
	const { run } = await import("./scenarios/sweep.mjs");
	const { failed } = await run({ session: readSession(), verbose: opts.verbose, only: opts.only });
	if (!opts.keep) await verbDown();
	return failed > 0 ? 1 : 0;
}

/**
 * 壊れた応答への耐性。1周は 72 件で 20〜30 分かかる（送り直しの待ちと
 * タイムアウトが経路の数だけ乗るため）。CI には入れず、--only / --nasty で絞って使う。
 */
async function presetResilience(opts) {
	if (!requireTmpWorkspace("resilience")) return 2;
	if (!liveSession()) await verbUp({ host: "headless", ai: "echo", ws: "tmp", reset: true, name: "resilience" });
	const { run } = await import("./scenarios/resilience.mjs");
	const { failed } = await run({
		session: readSession(),
		verbose: opts.verbose,
		only: opts.only,
		nasty: opts.nasty,
	});
	if (!opts.keep) await verbDown();
	return failed > 0 ? 1 : 0;
}

/**
 * 実 UI でしか見えないものを撮る。**ホストは code-server でなければ意味がない**ので、
 * 別のホストが立っているときは黙って使わず、いったん落としてから起こし直す。
 * echo をわざと遅らせるのは、翻訳中のツリーを撮るため（速いと1枚も捉えられない）。
 */
async function presetUx(opts) {
	const { UP_ARGS, run } = await import("./scenarios/ux.mjs");
	const session = liveSession();
	if (session && !session.hostDead && session.host !== "code-server") await verbDown();
	if (!liveSession() || readSession()?.host !== "code-server") {
		// UP_ARGS は動詞 up の引数列。ここで組み直さず、シナリオ側の定義をそのまま使う
		await verbUp(parseArgs(UP_ARGS.slice(1), { booleans: BOOLEANS }));
	}
	const { failed } = await run({ session: readSession(), verbose: opts.verbose, only: opts.only });
	if (!opts.keep) await verbDown();
	return failed > 0 ? 1 : 0;
}

/** 頑健性プローブ（観察するだけ）。判定はしない */
/**
 * 改訂の出力形式を比べる。
 *
 * **lab のセッションには触らない。** 見たいのは AI の答えだけで、VS Code もワークスペースも
 * 要らないため、ホストは起こさず AI の受け皿だけを立てて、終わったら必ず落とす。
 * 別の実験が立っていても邪魔をしない。
 */
async function presetBenchRevise(opts) {
	const bench = await import("./scenarios/bench-revise.mjs");
	if (opts["self-test"]) return bench.selfTestCommand();

	// 自前の行き先（llama.cpp など）を渡されたら、受け皿は立てない
	const external = opts["base-url"];
	let ai = null;
	if (!external) {
		ai = await startShim("agent", { agentModel: opts.model ?? "haiku", agentCommand: opts["agent-command"] });
		if (!ai?.baseURL) throw new Error("AI の受け皿が立ちませんでした");
		say(`翻訳役: claude（--model ${opts.model ?? "haiku"}） ${ai.baseURL}`);
	}
	const { runDir } = createRun("bench-revise");
	try {
		const result = await bench.run({
			cases: opts.cases,
			variants: opts.variants,
			repeat: opts.repeat,
			concurrency: opts.concurrency,
			timeout: opts.timeout,
			baseUrl: external ?? ai.baseURL,
			// shim は model を見ないが、自前の行き先には渡す必要がある
			model: opts.model ?? "haiku",
			apiKey: opts["api-key"],
			responseFormat: opts["response-format"],
			out: path.join(runDir, "bench-revise.json"),
			dry: opts.dry,
		});
		return result.failed > 0 ? 1 : 0;
	} finally {
		if (ai?.pid) stopShim({ ai });
	}
}

async function presetProbe(opts) {
	if (!requireTmpWorkspace("probe")) return 2;
	if (!liveSession()) await verbUp({ host: "headless", ai: "echo", ws: "tmp", reset: true, name: "probe" });
	const { run } = await import("./scenarios/probe.mjs");
	await run({ session: readSession(), only: opts.only, diff: opts.diff, time: opts.time, noDiff: opts["no-diff"] });
	if (!opts.keep) await verbDown();
	return 0;
}

/**
 * 録音の再生。要求が録音と1文字でも違えば shim が 409 を返し、ここで落ちる。
 * つまり「指示文の組み立てが変わった」ことに気づける。
 */
/**
 * 改訂（revise）を誘発するために原文へ加える編集。
 *
 * **録音と1文字でも違ってはいけない** — 違うと原文差分が変わり、送る指示文も変わって
 * 再生が 409 で止まる。録音を録り直すときも同じ編集を使うこと。
 */
const REVISE_EDIT = {
	file: "content/ja/10_test.md",
	from: "これは日本語のテスト用 Markdown ファイルです。",
	to: "これは日本語のテスト用 Markdown ファイルです。改訂の録音のために一文を足した。",
};

async function presetRegress(opts) {
	let code = 0;

	// --- 新規翻訳の往復 ---
	const recording = opts.replay ?? path.join(HERE, "ai/recordings/trans-en-child.jsonl");
	if (liveSession()) await verbDown();
	await verbUp({ host: "headless", ai: "replay", replay: recording, ws: "tmp", reset: true, name: "regress" });
	try {
		await runOne({ _: ["mdait.sync"] });
		const { result } = await runOne({ _: ["mdait.translate.directory", "content/en/child"] });
		const failedFiles = result?.result?.failed ?? 0;
		if (failedFiles > 0) {
			warn(`新規翻訳の再生が食い違いました（${failedFiles} ファイルが失敗）。指示文の組み立てが変わっています。`);
			warn("意図した変更なら録り直す。意図しないなら変更を戻す。どちらかを決めてから進むこと。");
			code = 1;
		} else {
			say("新規翻訳: 録音のとおりに再生できました（LLM 呼び出し 0 回）。");
		}
	} finally {
		await verbDown();
	}

	// --- 改訂の往復（`--replay` で別の録音を指したときは、そちらだけを見る） ---
	if (opts.replay) return code;
	const reviseRecording = path.join(HERE, "ai/recordings/trans-revise-10test.jsonl");
	if (!fs.existsSync(reviseRecording)) {
		warn(`改訂の録音がありません: ${reviseRecording}`);
		return 1;
	}
	await verbUp({
		host: "headless",
		ai: "replay",
		replay: reviseRecording,
		ws: "tmp",
		reset: true,
		name: "regress-revise",
	});
	try {
		await runOne({ _: ["mdait.sync"] });
		await runOne({ _: ["mdait.trans", "content/en/10_test.md"] });

		// 原文を変えて need:revise を立てる。編集は録音時とまったく同じでなければならない
		const session = readSession();
		const target = path.join(session.ws, REVISE_EDIT.file);
		const before = fs.readFileSync(target, "utf8");
		if (!before.includes(REVISE_EDIT.from)) {
			warn(`改訂を誘発する編集の目印が見つかりません: ${REVISE_EDIT.file}`);
			return 1;
		}
		fs.writeFileSync(target, before.replace(REVISE_EDIT.from, REVISE_EDIT.to), "utf8");
		await runOne({ _: ["mdait.sync"] });

		const { result } = await runOne({ _: ["mdait.trans", "content/en/10_test.md"] });
		const summary = result?.result ?? {};
		// **当たったことまで見る。** 往復が録音と合っていても、当てはめに失敗していれば
		// 改訂は成立していない（形式を変えたときにいちばん壊れるのがここ）
		const patched = summary.patchedCount ?? 0;
		const patchFailures = summary.patchFailures?.length ?? 0;
		if (patched !== 1 || patchFailures > 0) {
			warn(
				`改訂の再生が食い違いました（当たった件数 ${patched} / 当てはめ失敗 ${patchFailures}）。` +
					"指示文かパッチの読み方が変わっています。",
			);
			warn("意図した変更なら録り直す。意図しないなら変更を戻す。どちらかを決めてから進むこと。");
			code = 1;
		} else {
			say("改訂: 録音のとおりに再生でき、パッチも当たりました（LLM 呼び出し 0 回）。");
		}
	} finally {
		if (!opts.keep) await verbDown();
	}
	return code;
}

/**
 * 規模のある見本サイトを書き出す。
 *
 * 単体テストの見本（src/test/unit/sample-content）は小さく保つ設計なので、
 * 規模のあるものはそこへ置かずここで作る。作った先は `--ws <パス>` で作業場として指す。
 */
function verbSite(opts) {
	const out = opts.out ?? DEFAULT_SITE_DIR;
	const markers = oneOf(opts.markers ?? "embedded", ["embedded", "external"], "--markers");
	const stats = generateSite({ out, markers });
	say(`見本サイトを書き出しました: ${stats.dir}`);
	say(`  ファイル ${stats.files}（原文 ${stats.ja} / 訳文 ${stats.en}、うち CRLF ${stats.crlf}）`);
	say(
		`  内訳: ${Object.entries(stats.byKind)
			.map(([k, n]) => `${k} ${n}`)
			.join(" / ")}`,
	);
	say(`  マーカーの置き場: ${markers}`);
	say("");
	say("次にすること:");
	say(`  node scripts/lab/lab.mjs up --ws ${stats.dir} --ai agent --agent-model haiku`);
	say("  node scripts/lab/lab.mjs run mdait.adopt.run");
	return 0;
}

/**
 * 見本サイトを静的サイトジェネレータで建てる。
 *
 * 書式を守れているかは、これまで原稿のバイト列でしか測っていなかった。サイトの持ち主が
 * 本当に見るのは建ったサイトなので、取り込みの前後で建てて比べる。frontmatter の型が崩れれば
 * その場で失敗し、本文の構造が崩れれば出力の HTML が変わる。
 */
function verbHugo(opts) {
	const dir = opts.ws ?? DEFAULT_SITE_DIR;
	const result = buildSite({ dir });
	if (result.skipped) {
		say(`Hugo を試せませんでした: ${result.skipped}`);
		return 0;
	}
	if (!result.ok) {
		say(`ビルドが失敗しました（終了コード ${result.code}）: ${dir}`);
		say(result.stderr.split("\n").slice(0, 20).join("\n"));
		return 1;
	}
	say(`建ちました: ${dir}/public（HTML ${result.pages} 本・${result.seconds} 秒）`);

	if (opts.baseline) {
		const before = JSON.parse(fs.readFileSync(opts.baseline, "utf8"));
		const diff = compareDigests(before, result.digest);
		const total = diff.added.length + diff.removed.length + diff.changed.length;
		say(
			total === 0
				? `  ${path.basename(opts.baseline)} と比べて、出力は1バイトも変わっていません`
				: `  ${path.basename(opts.baseline)} と比べて: 増 ${diff.added.length} / 減 ${diff.removed.length} / 変化 ${diff.changed.length}`,
		);
		for (const kind of ["added", "removed", "changed"]) {
			for (const rel of diff[kind].slice(0, 12))
				say(`    ${kind === "added" ? "+" : kind === "removed" ? "-" : "~"} ${rel}`);
			if (diff[kind].length > 12) say(`    … ほか ${diff[kind].length - 12} 件`);
		}
	}
	if (opts.save) {
		fs.mkdirSync(path.dirname(path.resolve(opts.save)), { recursive: true });
		fs.writeFileSync(opts.save, `${JSON.stringify(result.digest, null, 2)}\n`, "utf8");
		say(`  指紋を残しました: ${opts.save}`);
	}
	return 0;
}

// ===========================================================================
// 入口
// ===========================================================================

async function main() {
	const argv = process.argv.slice(2);
	if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
		say(HELP);
		return 0;
	}
	const verb = argv[0];
	const opts = parseArgs(argv.slice(1), { booleans: BOOLEANS });
	if (opts.help) {
		say(HELP);
		return 0;
	}

	if (PRESETS[verb]) return await runPreset(verb, opts);

	switch (verb) {
		case "up":
			return await verbUp(opts);
		case "run":
			return await verbRun(opts);
		case "shot":
			return await verbShot(opts);
		case "ai":
			return await verbAi(opts);
		case "cancel":
			return verbCancel();
		case "status":
			return await verbStatus(opts);
		case "reset":
			return await verbReset(opts);
		case "site":
			return verbSite(opts);
		case "hugo":
			return verbHugo(opts);
		case "report":
			return await verbReport(opts);
		case "down":
			return await verbDown(opts);
		default:
			throw new UsageError(`知らない動詞です: ${verb}\n\n${HELP}`);
	}
}

main()
	.then((code) => {
		process.exit(code ?? 0);
	})
	.catch((error) => {
		if (error instanceof UsageError) {
			warn(error.message);
			process.exit(2);
		}
		warn(error?.stack ?? String(error));
		process.exit(1);
	});
