#!/usr/bin/env node
/*
 * ホスト: デスクトップ版 VS Code の Extension Development Host
 *
 * 旧 debug-ipc の起動スクリプト（PowerShell）を Node に移したもの。
 * Windows / mac / Linux のどこでも同じ呼び方で動く。
 *
 * 命令はファイル IPC（<ws>/.mdait/debug/command.json）で送る。
 * 手元の本物のプロバイダ（vscode.lm など）を使いたいときはこのホストを選ぶ。
 *
 * 確認ダイアログについて: headless は vscode シムが、code-server は常駐ページの見張りが
 * 代わりに答える。デスクトップ版は本物の画面なので、**そこに居る人が答える**。
 * 答えるまで `lab run` は返らない（result.json が running のまま）。画面を見ていない場では
 * headless か code-server を使うこと。
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ipcPaths, waitReady } from "../lib/ipc.mjs";
import { LAB_DIR } from "../lib/session.mjs";
import { prepareWorkspace } from "../lib/workspace.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** AI 利用の確認ダイアログを覚えさせるためのプロファイル名 */
const PROFILE = "mdait-debug";

function log(message) {
	console.log(`[desktop] ${message}`);
}

/** リポジトリのルート（package.json の name が mdait のところ）を探す */
function repoRoot() {
	if (process.env.MDAIT_REPO) return path.resolve(process.env.MDAIT_REPO);
	let dir = HERE;
	for (let i = 0; i < 8; i++) {
		const pkg = path.join(dir, "package.json");
		if (fs.existsSync(pkg)) {
			try {
				if (JSON.parse(fs.readFileSync(pkg, "utf-8")).name === "mdait") return dir;
			} catch {
				// 読めない package.json は無視して上へ
			}
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error("mdait のリポジトリルートが見つかりません（MDAIT_REPO で指定してください）");
}

function sh(command, args, opts = {}) {
	const cwd = opts.cwd || process.cwd();
	log(`$ ${command} ${args.join(" ")}  (${cwd})`);
	const result = spawnSync(command, args, {
		cwd,
		stdio: opts.quiet ? "pipe" : "inherit",
		env: { ...process.env, ...(opts.env || {}) },
		shell: process.platform === "win32",
		encoding: "utf-8",
	});
	if (result.status !== 0 && !opts.allowFailure) {
		throw new Error(`コマンドが失敗しました: ${command} ${args.join(" ")}`);
	}
	return result;
}

/** バージョン文字列（1.2.3）を比較用の数値にする */
function versionKey(text) {
	const m = /(\d+)\.(\d+)\.(\d+)/.exec(text || "");
	if (!m) return 0;
	return Number(m[1]) * 1000000 + Number(m[2]) * 1000 + Number(m[3]);
}

/** そのプラットフォームでの VS Code 実行ファイルの位置（テスト用に落としたもの） */
function binaryInsideCache(dir) {
	if (process.platform === "win32") return path.join(dir, "Code.exe");
	if (process.platform === "darwin") {
		for (const app of ["Visual Studio Code.app", "Visual Studio Code - Insiders.app"]) {
			const p = path.join(dir, app, "Contents", "MacOS", "Electron");
			if (fs.existsSync(p)) return p;
		}
		return null;
	}
	for (const name of ["code", "code-insiders"]) {
		const p = path.join(dir, name);
		if (fs.existsSync(p)) return p;
	}
	return null;
}

/** システムに入っている VS Code */
function systemBinary() {
	const candidates = [];
	if (process.platform === "win32") {
		const local = process.env.LOCALAPPDATA || "";
		candidates.push(
			path.join(local, "Programs", "Microsoft VS Code", "Code.exe"),
			path.join(process.env.ProgramFiles || "C:\\Program Files", "Microsoft VS Code", "Code.exe"),
		);
	} else if (process.platform === "darwin") {
		candidates.push("/Applications/Visual Studio Code.app/Contents/MacOS/Electron");
	} else {
		for (const dir of (process.env.PATH || "").split(path.delimiter)) {
			if (dir) candidates.push(path.join(dir, "code"));
		}
		candidates.push("/usr/share/code/code", "/usr/bin/code");
	}
	return candidates.find((p) => p && fs.existsSync(p)) || null;
}

/** 実行ファイルに版を聞く（聞けなければ null） */
function askVersion(binary) {
	try {
		const r = spawnSync(binary, ["--version"], { encoding: "utf-8", timeout: 20000 });
		const first = (r.stdout || "").split(/\r?\n/)[0].trim();
		return /^\d+\.\d+\.\d+/.test(first) ? first : null;
	} catch {
		return null;
	}
}

/**
 * 起動する VS Code を決める。
 *
 * @vscode/test-electron が .vscode-test に落としたものを版の新しい順に見る。
 * ただし**システムに入っているものと同じ版は避ける** — 同じ版だと mutex の取り合いになり、
 * 起動要求が既存のインスタンスへ転送されて MDAIT_DEBUG_IPC が伝わらず、ready にならない。
 * 落としたものが無ければシステムのものを使う（その場合は下の .ipc-enabled が保険になる）。
 */
function resolveVsCode(repo) {
	if (process.env.MDAIT_LAB_VSCODE) return { binary: process.env.MDAIT_LAB_VSCODE, version: null };
	const cacheDir = path.join(repo, ".vscode-test");
	const system = systemBinary();
	const systemVersion = system ? askVersion(system) : null;
	if (systemVersion) log(`システムの VS Code: ${systemVersion}（同じ版は避ける）`);

	const found = [];
	if (fs.existsSync(cacheDir)) {
		for (const entry of fs.readdirSync(cacheDir, { withFileTypes: true })) {
			if (!entry.isDirectory() || !entry.name.startsWith("vscode-")) continue;
			const binary = binaryInsideCache(path.join(cacheDir, entry.name));
			if (!binary) continue;
			const version = (/(\d+\.\d+\.\d+)/.exec(entry.name) || [])[1] || null;
			found.push({ binary, version, key: versionKey(entry.name) });
		}
	}
	found.sort((a, b) => b.key - a.key);

	const differs = found.find((c) => !systemVersion || c.version !== systemVersion);
	const picked = differs || found[0] || (system ? { binary: system, version: systemVersion } : null);
	if (!picked) {
		throw new Error(
			"VS Code が見つかりません。`npm run test:vscode` を一度流して取得するか、VS Code を入れてください",
		);
	}
	if (!differs && found.length > 0) {
		log("警告: システムと同じ版しかありません。mutex の取り合いで ready にならないかもしれません");
	}
	return picked;
}

/** そのプラットフォームでの VS Code の設定フォルダ（User の下） */
function systemUserDir() {
	if (process.platform === "win32") return path.join(process.env.APPDATA || "", "Code", "User");
	if (process.platform === "darwin")
		return path.join(os.homedir(), "Library", "Application Support", "Code", "User");
	return path.join(os.homedir(), ".config", "Code", "User");
}

/**
 * 初回だけ、普段使いの VS Code から Copilot の同意データとプロファイルを写す。
 * まっさらな user-data だと AI 利用の確認ダイアログで止まり、拡張が ready にならないため。
 */
function seedUserData(userDataDir) {
	const target = path.join(userDataDir, "User", "globalStorage");
	if (fs.existsSync(target)) return;
	log("user-data を用意します（初回のみ）");
	fs.mkdirSync(target, { recursive: true });
	const source = systemUserDir();
	const sourceStorage = path.join(source, "globalStorage");
	if (fs.existsSync(sourceStorage)) {
		for (const entry of fs.readdirSync(sourceStorage, { withFileTypes: true })) {
			if (!entry.isDirectory() || !entry.name.startsWith("github.copilot")) continue;
			try {
				fs.cpSync(path.join(sourceStorage, entry.name), path.join(target, entry.name), {
					recursive: true,
				});
			} catch {
				// 写せなくても致命的ではない
			}
		}
	}
	const sourceProfiles = path.join(source, "profiles");
	if (fs.existsSync(sourceProfiles)) {
		try {
			fs.cpSync(sourceProfiles, path.join(userDataDir, "User", "profiles"), { recursive: true });
		} catch {
			// 同上
		}
	}
}

function pidFile() {
	return path.join(LAB_DIR, "desktop.pid");
}

function readPid(file) {
	try {
		return Number(fs.readFileSync(file, "utf-8").trim()) || null;
	} catch {
		return null;
	}
}

function alive(pid) {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function stopPid(pid) {
	if (!alive(pid)) return false;
	try {
		process.kill(pid, "SIGTERM");
		return true;
	} catch {
		return false;
	}
}

/**
 * ファイル IPC を有効にし、前回の残りカスを消す。
 * 環境変数（MDAIT_DEBUG_IPC）は mutex 転送で失われることがあるので、
 * .ipc-enabled ファイルを保険として置く（src/extension.ts がどちらでも起動する）。
 */
function enableIpc(ws) {
	const paths = ipcPaths(ws);
	fs.mkdirSync(paths.dir, { recursive: true });
	fs.writeFileSync(paths.enableFile, "", "utf-8");
	for (const file of [paths.readyFile, paths.resultFile, paths.commandFile]) {
		fs.rmSync(file, { force: true });
	}
	return paths;
}

/**
 * Extension Development Host を起こし、ready になるまで待つ。
 *
 * @param {object} options
 *   ws     : 用意済みのワークスペース。無ければ wsMode から用意する
 *   wsMode : "tmp" | "repo" | 絶対パス（既定 "repo" — 手元の VS Code で見るため）
 *   skipBuild : true ならコンパイルとバンドルを飛ばす
 *   readyTimeoutSec : ready 待ちの上限（既定 120 秒）
 */
export async function up(options = {}) {
	const repo = repoRoot();
	const ws =
		options.ws || (await prepareWorkspace({ mode: options.wsMode || "repo", reset: options.reset }));

	if (!options.skipBuild) {
		// Extension Host は dist/extension.js を読むので、bundle:dev まで必ず走らせる
		sh("npm", ["run", "compile"], { cwd: repo });
		sh("npm", ["run", "bundle:dev"], { cwd: repo });
	}

	const { binary, version } = resolveVsCode(repo);
	log(`使う VS Code: ${binary}${version ? ` (${version})` : ""}`);

	const userDataDir = path.join(repo, ".vscode-test", "user-data");
	seedUserData(userDataDir);
	enableIpc(ws);

	// 前に自分が起こしたものが残っていれば止める（PID で止める。広く殺さない）
	const previous = readPid(pidFile());
	if (stopPid(previous)) log(`前回のホストを止めました pid=${previous}`);

	fs.mkdirSync(LAB_DIR, { recursive: true });
	const logFile = path.join(LAB_DIR, "desktop.log");
	const out = fs.openSync(logFile, "a");
	const child = spawn(
		binary,
		[
			"--new-window",
			`--extensionDevelopmentPath=${repo}`,
			ws,
			`--profile=${PROFILE}`,
			`--user-data-dir=${userDataDir}`,
			"--disable-workspace-trust",
		],
		{
			detached: true,
			stdio: ["ignore", out, out],
			env: { ...process.env, MDAIT_DEBUG_IPC: "1" },
		},
	);
	child.unref();
	fs.writeFileSync(pidFile(), String(child.pid), "utf-8");
	log(`起動しました pid=${child.pid} ログ=${logFile}`);

	await waitReady(ws, options.readyTimeoutSec || 120);
	log("拡張の ready を確認しました");

	return { pid: child.pid, ws, binary, version, logFile };
}

/**
 * 自分が起こしたものだけを PID で止める。
 * @returns {Promise<{stopped: boolean, pid: number|null, reason: string}>}
 */
export async function down(session = {}) {
	const pid = session.hostPid || readPid(pidFile());
	const stopped = stopPid(pid);
	fs.rmSync(pidFile(), { force: true });
	const reason = stopped ? `止めました pid=${pid}` : "止めるものはありませんでした";
	log(reason);
	return { stopped, pid, reason };
}

/** 今どうなっているかを一行で */
export async function status(session = {}) {
	const pid = session.hostPid || readPid(pidFile());
	const ws = session.ws || "(不明)";
	const ready = ws !== "(不明)" && fs.existsSync(ipcPaths(ws).readyFile);
	return `desktop pid=${pid ?? "なし"} ${alive(pid) ? "動作中" : "停止"} ws=${ws} ready=${ready ? "あり" : "なし"}`;
}
