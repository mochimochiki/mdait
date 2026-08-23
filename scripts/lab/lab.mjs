#!/usr/bin/env node
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
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { UsageError, asNumber, oneOf, parseArgs } from "./lib/args.mjs";
import { LAB_DIR, clearSession, ensureLabDir, readSession, writeSession } from "./lib/session.mjs";
import { ipcPaths, sendCommand } from "./lib/ipc.mjs";
import { configureAi, prepareWorkspace, restoreConfig } from "./lib/workspace.mjs";
import { buildReport, createRun, saveStep, snapshotBaseline } from "./lib/runs.mjs";
import { summarizeResult } from "./lib/digest.mjs";
import { COMMANDS } from "./hosts/registry.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AI_DIR = path.join(HERE, "ai");
const SHIM = path.join(AI_DIR, "shim.mjs");

const HOSTS = ["headless", "code-server", "desktop"];
const AI_MODES = ["echo", "live", "agent", "script", "replay", "none"];

const BOOLEANS = ["reset", "json", "help", "quiet", "dry", "verbose", "keep", "time", "no-diff"];

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
            --replay <ファイル>       replay モードの録音
            --record <ファイル>       やり取りを録音する
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
  status  いまの様子と直近の手順を出す
  reset   作業場を見本から作り直す（ホストは止めない）
  report  run ディレクトリから report.md を組み立てて場所を出す
  down    ホストと AI の相手を止め、退避した設定を戻す

ひとまとめの段取り（低レベルな動詞の組み合わせ。独自の実装は持ちません）
  sweep    決定的スイープ（旧 npm run test:explore）。FAIL があれば終了コード 1
            --only P1,P5   段を絞る    --verbose 通った判定も出す    --keep 終わっても止めない
  probe    頑健性プローブ（旧 probe-robustness）。判定せず観察し、前回の run と比べる
            --only S3,S13  シナリオを絞る    --diff <runのパス>  比べる相手    --time 所要時間も出す
  regress  録音の再生（旧 npm run test:byok:e2e）。食い違えば終了コード 1
            --replay <ファイル>  別の録音を再生する
  prompt   指示文の比べ読み（未実装。組み立て方だけ出ます）
  ux       ブラウザ版 VS Code で mdait のビューを開いて撮る（未実装。組み立て方だけ出ます）

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
	if (options.replay) argv.push("--replay", path.resolve(options.replay));
	if (options.record) argv.push("--record", path.resolve(options.record));
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

	const host = oneOf(opts.host, HOSTS, "--host") ?? "headless";
	const aiMode = oneOf(opts.ai, AI_MODES, "--ai") ?? "echo";
	const wsMode = opts.ws ?? "tmp";
	const reset = Boolean(opts.reset);

	const ws = await prepareWorkspace({ mode: wsMode, reset });
	say(`作業場: ${ws}${reset ? "（見本から作り直しました）" : ""}`);

	const ai = await startShim(aiMode, {
		delay: opts.delay,
		script: opts.script,
		replay: opts.replay,
		record: opts.record,
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
	if (!ai || ai.mode === "none") throw new UsageError("AI の相手が立っていません（`lab up --ai echo` などで始めてください）");
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
		names = fs.readdirSync(mailbox).filter((n) => pattern.test(n)).sort();
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
		names = fs.readdirSync(path.join(session.runDir, "steps")).filter((n) => n.endsWith(".json")).sort();
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
		say(result.stopped ? `ホストを止めました（pid ${result.pid ?? session.hostPid}${result.forced ? " — 強く止めました" : ""}）` : `ホスト: ${result.reason}`);
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
	prompt: {
		note: "指示文の比べ読み。claude を翻訳役に立てて同じ原稿を訳し、録音を見比べる",
		steps: [
			"lab up --host headless --ai agent --ws tmp --reset --record <録音先>",
			"lab run mdait.translate.directory <対象フォルダ>",
			"lab ai last ／ lab report",
		],
	},
	ux: {
		note: "ブラウザ版 VS Code を起こして mdait のビューを開き、初めの姿を撮る",
		steps: ["lab up --host code-server --ai echo --ws tmp --reset --name ux", "lab shot 初期状態", "lab report"],
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

/** スイープ（決定的な総なめ）。判定は scenarios/sweep.mjs が持つ */
async function presetSweep(opts) {
	if (!liveSession()) await verbUp({ host: "headless", ai: "echo", ws: "tmp", reset: true, name: "sweep" });
	const { run } = await import("./scenarios/sweep.mjs");
	const { failed } = await run({ session: readSession(), verbose: opts.verbose, only: opts.only });
	if (!opts.keep) await verbDown();
	return failed > 0 ? 1 : 0;
}

/** 頑健性プローブ（観察するだけ）。判定はしない */
async function presetProbe(opts) {
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
async function presetRegress(opts) {
	const recording = opts.replay ?? path.join(HERE, "ai/recordings/trans-en-child.jsonl");
	if (liveSession()) await verbDown();
	await verbUp({ host: "headless", ai: "replay", replay: recording, ws: "tmp", reset: true, name: "regress" });
	let code = 0;
	try {
		await runOne({ _: ["mdait.sync"] });
		const { result } = await runOne({ _: ["mdait.translate.directory", "content/en/child"] });
		const summary = result?.result;
		const failedFiles = summary?.failed ?? 0;
		if (failedFiles > 0) {
			warn(`再生が食い違いました（${failedFiles} ファイルが失敗）。指示文の組み立てが変わっています。`);
			warn("意図した変更なら録り直す。意図しないなら変更を戻す。どちらかを決めてから進むこと。");
			code = 1;
		} else {
			say("録音のとおりに再生できました（LLM 呼び出し 0 回）。指示文の組み立ては変わっていません。");
		}
	} finally {
		if (!opts.keep) await verbDown();
	}
	return code;
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
		case "status":
			return await verbStatus(opts);
		case "reset":
			return await verbReset(opts);
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
