#!/usr/bin/env node
/*
 * headless ホスト — VS Code を立てずに mdait のコマンドを動かす常駐サーバー。
 *
 * VS Code の Extension Host を起こせない場所（クラウドの作業環境など）でも、
 * out/ にコンパイル済みの commands 層を Node から直に呼べば「機構」は確かめられる。
 * vscode の API は scripts/lab/vscode-shim.js が実ファイル委譲で肩代わりする。
 *
 * 命令の受け渡しは他のホストと同じファイル経由（<ws>/.mdait/debug/command.json →
 * result.json）。返す形は src/infra/debug/debug-command-handler.ts と揃えてある。
 * ただし fireTimeline / stateDiff / syncAnalysis は載せない。あれは「画面へ変更が
 * 伝わったか」を見るためのもので、画面の無い headless では常に空になり、
 * 「伝わっていない」と読み違える元になるからである。
 *
 * 使い方（ふつうは lab.mjs 経由で起こす）:
 *   node scripts/lab/hosts/headless.mjs --serve --ws /tmp/mdait-lab/ws
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { ipcPaths } from "../lib/ipc.mjs";
import { COMMANDS, UI_ONLY_NOTE, lookup, transformArgs } from "./registry.mjs";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const SELF = path.join(HERE, "headless.mjs");

/** out/ の中を読む近道 */
function out(rel) {
	return require(path.join(REPO, "out", rel));
}

// ===========================================================================
// ホストとしての顔（lab.mjs はこの3つだけを呼ぶ）
// ===========================================================================

/**
 * 常駐を起こす。自分自身を切り離した子として立ち上げ、受け入れ準備が済むまで待つ。
 *
 * @param {{ws: string, logLevel?: string, logFile?: string, timeoutSec?: number}} options
 * @returns {Promise<{pid: number, ws: string}>}
 */
export async function up(options = {}) {
	const ws = options.ws;
	if (!ws) throw new Error("headless の起動には --ws（作業場）が要ります");
	const paths = ipcPaths(ws);
	fs.mkdirSync(paths.dir, { recursive: true });
	// この中身はリポジトリに載せない
	fs.writeFileSync(path.join(paths.dir, ".gitignore"), "*\n", "utf8");
	for (const file of [paths.readyFile, paths.commandFile, paths.resultFile]) {
		fs.rmSync(file, { force: true });
	}
	// 実 VS Code のホストと同じ合図を置いておく（ホストを取り替えても道具立てが変わらないように）
	fs.writeFileSync(paths.enableFile, "", "utf8");

	const logFile = options.logFile ?? path.join(paths.dir, "headless.log");
	const fd = fs.openSync(logFile, "a");
	const argv = ["--serve", "--ws", ws];
	if (options.logLevel) argv.push("--log-level", options.logLevel);
	const child = spawn(process.execPath, [SELF, ...argv], {
		cwd: REPO,
		detached: true,
		stdio: ["ignore", fd, fd],
	});
	child.unref();

	let exited = null;
	child.on("exit", (code) => {
		exited = code;
	});

	const timeoutSec = options.timeoutSec ?? 120;
	const limit = Date.now() + timeoutSec * 1000;
	while (Date.now() < limit) {
		if (fs.existsSync(paths.readyFile)) {
			child.removeAllListeners("exit");
			return { pid: child.pid, ws, logFile };
		}
		if (exited !== null) {
			throw new Error(`headless が立ち上がる前に終了しました（終了コード ${exited}）。${logFile} を見てください\n${tail(logFile)}`);
		}
		await sleep(150);
	}
	throw new Error(`headless が ${timeoutSec} 秒たっても受け入れ準備を終えませんでした。${logFile} を見てください\n${tail(logFile)}`);
}

/** 常駐を止める。commands 層はタイマーと見張りを残すので、待っても自然には終わらない */
export async function down(session) {
	const pid = session?.hostPid;
	if (!pid) return { stopped: false, reason: "動いているホストの記録がありません" };
	if (!alive(pid)) return { stopped: false, reason: `pid ${pid} は既にいません` };
	try {
		process.kill(pid, "SIGTERM");
	} catch {}
	for (let i = 0; i < 25; i += 1) {
		if (!alive(pid)) return { stopped: true, pid };
		await sleep(200);
	}
	try {
		process.kill(pid, "SIGKILL");
	} catch {}
	return { stopped: true, pid, forced: true };
}

/** 今どうなっているかを1行で */
export async function status(session) {
	const pid = session?.hostPid;
	const ws = session?.ws;
	if (!pid) return "headless: 起動の記録がありません";
	const living = alive(pid);
	const ready = ws ? fs.existsSync(ipcPaths(ws).readyFile) : false;
	return `headless: pid ${pid} は${living ? "動いています" : "いません"} / 受け入れ準備 ${ready ? "済み" : "まだ"} / 作業場 ${ws ?? "(不明)"}`;
}

function alive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** ログの末尾だけ見せる（起動に失敗したときの手掛かり） */
function tail(file, lines = 20) {
	try {
		return fs.readFileSync(file, "utf8").split("\n").slice(-lines).join("\n");
	} catch {
		return "";
	}
}

// ===========================================================================
// --serve 本体
// ===========================================================================

/** 命令を待つ間隔 */
const POLL_MS = 150;

async function serve(argv) {
	const wsAt = argv.indexOf("--ws");
	if (wsAt < 0 || !argv[wsAt + 1]) throw new Error("--serve には --ws <作業場> が要ります");
	const ws = path.resolve(argv[wsAt + 1]);
	const levelAt = argv.indexOf("--log-level");
	const logLevel = levelAt >= 0 ? argv[levelAt + 1] : "INFO";

	// 1) vscode の肩代わりを読み込む。どこを作業場とみなすかは読み込む前に決める
	global.__mdaitLabWorkspaceRoot = ws;
	process.env.MDAIT_LAB_WS = ws;
	// 実 Extension Host のデバッグ IPC と同じ立場だと名乗る。
	// 「AI を初めて使いますが良いですか」の確認は、誰も答えられないここでは飛ばしてもらう
	process.env.MDAIT_DEBUG_IPC = "1";
	const { vscode } = require(path.join(REPO, "scripts", "lab", "vscode-shim.js"));

	const paths = ipcPaths(ws);
	fs.mkdirSync(paths.dir, { recursive: true });
	const logFile = path.join(paths.dir, "headless.log");
	const say = (text) => {
		const line = `[${new Date().toISOString()}] ${text}`;
		process.stdout.write(`${line}\n`);
	};

	// 2) mdait のログを拾えるようにする（出力窓の代わりにログファイルへ流す）
	const { Logger, parseLogLevel } = out("infra/logging/logger.js");
	const logger = Logger.getInstance();
	logger.initialize({
		appendLine: (line) => {
			try {
				fs.appendFileSync(logFile, `${line}\n`);
			} catch {}
		},
		append: () => {},
		clear: () => {},
		show: () => {},
		hide: () => {},
		dispose: () => {},
	});
	logger.setLevel(parseLogLevel(logLevel));

	// 3) 設定を読む
	const { Configuration } = out("infra/config/configuration.js");
	await Configuration.getInstance().load();
	say(`設定を読みました: ${ws}/.mdait/mdait.json`);

	// 4) 対象言語をぜんぶ選んでおく。初期状態は「何も選んでいない」で、
	//    このままだと sync が何も見ずに終わる
	const { SelectionState } = out("core/status/selection-state.js");
	const selection = SelectionState.getInstance();
	const keys = selection.getSelectableTargets().map((t) => t.key);
	selection.updateSelection(keys);
	say(`対象言語を ${keys.length} 件選びました: ${keys.join(", ") || "(なし)"}`);

	// 5) 一覧（ステータスツリー）を組んでおく。ツリーを見て動くコマンドがあるため
	await rebuildTree(say);

	// 6) 受け入れ準備ができた合図
	fs.writeFileSync(paths.readyFile, new Date().toISOString(), "utf8");
	say("受け入れ準備ができました。命令を待ちます");

	// 止める合図は必ず自分で受ける（commands 層がタイマーと見張りを残すため、
	// 待っていてもこのプロセスは終わらない）
	const stop = (why) => {
		say(`終わります（${why}）`);
		try {
			fs.rmSync(paths.readyFile, { force: true });
		} catch {}
		process.exit(0);
	};
	process.on("SIGTERM", () => stop("SIGTERM"));
	process.on("SIGINT", () => stop("SIGINT"));

	// 7) 命令を待つ
	let busy = false;
	for (;;) {
		if (!busy && fs.existsSync(paths.commandFile)) {
			busy = true;
			try {
				const finished = await handleOnce(ws, vscode, logger, say);
				if (finished === "shutdown") stop("lab.shutdown");
			} catch (error) {
				say(`命令の処理でつまずきました: ${error?.message ?? error}`);
			} finally {
				busy = false;
			}
		}
		await sleep(POLL_MS);
	}
}

/**
 * 作業場を作り直したあとに呼ぶ。
 *
 * ディスクを入れ替えても、このプロセスは前の中身を抱えたままである。
 * 設定・ユニット台帳（unit-registry）・ユニットの状態（unit-state）は、いずれも
 * 一度読んだら覚えている作りなので、明示的に捨てて読み直さないと、
 * 作り直す前の姿を相手に走り続ける。
 */
async function reload(say) {
	const { UnitRegistryManager } = out("core/unit-registry/unit-registry-manager.js");
	UnitRegistryManager.resetInstance();
	const { UnitStateStore } = out("core/unit-state/unit-state-store.js");
	UnitStateStore.dispose();
	const { Configuration } = out("infra/config/configuration.js");
	await Configuration.getInstance().load();
	const { SelectionState } = out("core/status/selection-state.js");
	const selection = SelectionState.getInstance();
	selection.updateSelection(selection.getSelectableTargets().map((t) => t.key));
	await rebuildTree(say);
	say("覚えていた中身を捨てて読み直しました");
}

/** ステータスツリーを組み直す。組めなくても止まらない */
async function rebuildTree(say) {
	try {
		const { StatusManager } = out("core/status/status-manager.js");
		await StatusManager.getInstance().buildStatusItemTree();
	} catch (error) {
		say(`一覧の組み立ては見送りました: ${error?.message ?? error}`);
	}
}

/** 途中まで書かれたものを掴むことがあるので、少し待って読み直す */
async function readCommandWithRetry(file) {
	for (let attempt = 0; attempt < 3; attempt += 1) {
		if (attempt > 0) await sleep(100);
		try {
			const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed.id === "string" && typeof parsed.command === "string") return parsed;
		} catch {}
	}
	return null;
}

function writeResult(file, payload) {
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
	fs.renameSync(tmp, file);
}

/** 命令を1つ受けて結果を書く。止める合図なら "shutdown" を返す */
async function handleOnce(ws, vscode, logger, say) {
	const paths = ipcPaths(ws);
	const payload = await readCommandWithRetry(paths.commandFile);
	if (!payload) {
		writeResult(paths.resultFile, blank({ error: "command.json を読めませんでした" }));
		fs.rmSync(paths.commandFile, { force: true });
		return;
	}

	const { id, command } = payload;
	const args = Array.isArray(payload.args) ? payload.args : [];
	const startedAt = new Date().toISOString();
	writeResult(paths.resultFile, blank({ id, command, status: "running", startedAt }));

	if (command === "lab.reload") {
		try {
			await reload(say);
			writeResult(
				paths.resultFile,
				blank({ id, command, status: "done", result: { reloaded: true }, startedAt, completedAt: new Date().toISOString() }),
			);
		} catch (error) {
			writeResult(
				paths.resultFile,
				blank({
					id,
					command,
					status: "error",
					error: error instanceof Error ? error.message : String(error),
					startedAt,
					completedAt: new Date().toISOString(),
				}),
			);
		}
		fs.rmSync(paths.commandFile, { force: true });
		return;
	}

	if (command === "lab.shutdown") {
		writeResult(
			paths.resultFile,
			blank({ id, command, status: "done", result: { stopped: true }, startedAt, completedAt: new Date().toISOString() }),
		);
		fs.rmSync(paths.commandFile, { force: true });
		return "shutdown";
	}

	const logs = [];
	const structuredLogs = [];
	const listener = logger.addLogListener((line, entry) => {
		logs.push(line);
		structuredLogs.push(entry);
	});

	say(`実行します: ${command} ${JSON.stringify(args)}`);
	try {
		const result = await invoke(command, args, vscode);
		const completedAt = new Date().toISOString();
		const errorCount = result && typeof result === "object" ? result.errorCount : undefined;
		const status = typeof errorCount === "number" && errorCount > 0 ? "done-with-errors" : "done";
		writeResult(
			paths.resultFile,
			blank({ id, command, status, result: result ?? null, logs, structuredLogs, startedAt, completedAt }),
		);
		say(`終わりました: ${command} → ${status}`);
	} catch (error) {
		writeResult(
			paths.resultFile,
			blank({
				id,
				command,
				status: "error",
				error: error instanceof Error ? error.message : String(error),
				logs,
				structuredLogs,
				startedAt,
				completedAt: new Date().toISOString(),
			}),
		);
		say(`つまずきました: ${command} → ${error?.message ?? error}`);
	} finally {
		listener.dispose();
		fs.rmSync(paths.commandFile, { force: true });
	}
	// 次の命令が古い一覧を見ないように組み直す（extension の sync 後と同じ手当て）
	await rebuildTree(say);
}

/** result.json の形。抜けている項目は必ず null か空で埋める（読む側が場合分けしなくて済む） */
function blank(over = {}) {
	return {
		id: null,
		command: null,
		status: "error",
		result: null,
		error: null,
		logs: [],
		structuredLogs: [],
		startedAt: null,
		completedAt: null,
		...over,
	};
}

// ===========================================================================
// コマンドの呼び出し
// ===========================================================================

/** クラスで書かれたコマンド置き場は1つだけ作って使い回す */
const instances = new Map();

/** headless だけの身代わり実装（登録されている本体が IPC から叩けないもの） */
const adapters = {
	/**
	 * 用語の検出。
	 *
	 * 登録されている `mdait.term.detect` は引数に (units, transPair) を取り、パスを受けない。
	 * そこで lm-tools の term-tool と同じ道筋（ソースファイルを集める → UnitPairCollector →
	 * detectTerm_CoreProc）をここで組み直している。
	 *
	 * @param {string} [target] 絞り込むファイルかフォルダ。省略すると全ペア
	 */
	async termDetect(target) {
		const { Configuration } = out("infra/config/configuration.js");
		const { FileExplorer } = out("infra/workspace/file-explorer.js");
		const { UnitPairCollector } = out("commands/term/unit-pair-collector.js");
		const { detectTerm_CoreProc } = out("commands/term/command-detect.js");

		const config = Configuration.getInstance();
		const explorer = new FileExplorer();
		const progress = { report: () => {} };
		const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) };
		const scope = target ? path.resolve(target) : undefined;

		const pairs = [];
		let newTerms = 0;
		for (const pair of config.transPairs) {
			let sourceFiles = await explorer.getSourceFiles(pair.sourceDir, config);
			if (scope) {
				sourceFiles = sourceFiles.filter((f) => f === scope || f.startsWith(`${scope}${path.sep}`));
			}
			if (sourceFiles.length === 0) continue;
			const collection = await new UnitPairCollector().collectFromFiles(sourceFiles, pair, token);
			const entries = await detectTerm_CoreProc(collection.pairs, pair, progress, token);
			newTerms += entries.length;
			pairs.push({
				sourceLang: pair.sourceLang,
				targetLang: pair.targetLang,
				sourceFiles: sourceFiles.length,
				newTerms: entries.length,
			});
		}
		return { pairs, newTerms };
	},
};

/** 拡張そのものの居場所を尋ねるコマンドのための、最低限の偽の context */
function fakeExtensionContext(vscode) {
	const memento = {
		get: () => undefined,
		update: async () => {},
		keys: () => [],
		setKeysForSync: () => {},
	};
	return {
		extensionPath: REPO,
		extensionUri: vscode.Uri.file(REPO),
		subscriptions: [],
		workspaceState: memento,
		globalState: memento,
	};
}

/** コマンド名から呼ぶものを決めて、実際に呼ぶ */
async function invoke(command, rawArgs, vscode) {
	const entry = lookup(command);
	if (!entry) {
		const known = Object.keys(COMMANDS).sort().join(", ");
		throw new Error(`${command} は headless の表にありません。${UI_ONLY_NOTE}\n表にあるもの: ${known}`);
	}
	if (!entry.hosts.includes("headless")) {
		throw new Error(`${command} は headless では動かせません。${entry.note}`);
	}
	const args = transformArgs(command, rawArgs, vscode);

	if (entry.adapter) {
		return await adapters[entry.adapter](...args);
	}
	const mod = out(entry.module.replace(/^out\//, ""));
	if (entry.method) {
		const key = `${entry.module}#${entry.export}`;
		if (!instances.has(key)) instances.set(key, new mod[entry.export]());
		const instance = instances.get(key);
		return await instance[entry.method](...args);
	}
	const fn = mod[entry.export];
	if (typeof fn !== "function") {
		throw new Error(`${entry.module} に ${entry.export} が見当たりません（compile し直してください）`);
	}
	if (command === "mdait.setup.createConfig") {
		return await fn(fakeExtensionContext(vscode), ...args);
	}
	return await fn(...args);
}

// このファイルを直接動かしたとき（= 子として起こされたとき）だけ常駐する
const invokedDirectly = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly && process.argv.includes("--serve")) {
	serve(process.argv.slice(2)).catch((error) => {
		process.stderr.write(`headless を立ち上げられませんでした: ${error?.stack ?? error}\n`);
		process.exit(1);
	});
}
