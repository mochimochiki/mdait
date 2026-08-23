#!/usr/bin/env node
/*
 * ホスト: code-server（ブラウザ版 VS Code）
 *
 * なぜブラウザ版か:
 *   このクラウド環境のネットワークは npm レジストリなどしか通さない。
 *   デスクトップ版 VS Code の配布元（update.code.visualstudio.com / GitHub Releases）は
 *   403 で塞がれるため、npm で配られている code-server を使う。
 *   ブラウザは環境に同梱の Chromium（/opt/pw-browsers/chromium）を Playwright で動かす。
 *
 * 命令はファイル IPC（<ws>/.mdait/debug/command.json）で送る。Playwright は画面を見る係。
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ipcPaths, waitReady } from "../lib/ipc.mjs";
import { LAB_DIR } from "../lib/session.mjs";
import { prepareWorkspace } from "../lib/workspace.mjs";
import { codeServerDir, connect } from "../ui/driver.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRIVER = path.join(HERE, "..", "ui", "driver.mjs");
const DEFAULT_PORT = Number(process.env.MDAIT_LAB_PORT || 8099);
/** 再現性が要るときは code-server@x.y.z の形で固定できる */
const CODE_SERVER_PKG = process.env.MDAIT_LAB_CODE_SERVER_PKG || "code-server";
const PLAYWRIGHT_PKG = process.env.MDAIT_LAB_PLAYWRIGHT_PKG || "playwright-core";

function log(message) {
	console.log(`[code-server] ${message}`);
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

/** コマンドを実行して、失敗したら止める */
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
	if (result.status !== 0) {
		if (opts.allowFailure) {
			log(`（失敗したが続ける: ${command}）`);
			return result;
		}
		throw new Error(`コマンドが失敗しました: ${command} ${args.join(" ")}`);
	}
	return result;
}

/** PATH から rg（ripgrep）を探す */
function findRg() {
	const exe = process.platform === "win32" ? "rg.exe" : "rg";
	for (const dir of (process.env.PATH || "").split(path.delimiter)) {
		if (!dir) continue;
		const candidate = path.join(dir, exe);
		if (fs.existsSync(candidate)) return candidate;
	}
	return null;
}

function csEntry(dir) {
	return path.join(dir, "node_modules", "code-server", "out", "node", "entry.js");
}

/**
 * kerberos のネイティブビルドに必要なヘッダを入れる。
 * apt-get update を先に通すこと — イメージ同梱のインデックスは古く、
 * 記載された版の .deb がミラーから消えていて 404 になる。update 無しの install は必ず失敗する。
 */
function ensureKerberosHeaders() {
	if (process.platform !== "linux") return;
	if (fs.existsSync("/usr/include/gssapi/gssapi.h")) return;
	const sudo = process.getuid && process.getuid() === 0 ? [] : ["sudo"];
	const run = (args) => {
		const [cmd, ...rest] = [...sudo, ...args];
		sh(cmd, rest, { allowFailure: true });
	};
	log("libkrb5-dev を入れます（kerberos のビルドに必要）");
	run(["apt-get", "update", "-qq"]);
	run(["apt-get", "install", "-y", "-qq", "libkrb5-dev"]);
	if (!fs.existsSync("/usr/include/gssapi/gssapi.h")) {
		log("警告: libkrb5-dev を入れられませんでした。kerberos のビルドで失敗するかもしれません");
	}
}

/** code-server 一式を作業ディレクトリに用意する（済んでいれば何もしない） */
function setupCodeServer(dir) {
	fs.mkdirSync(dir, { recursive: true });
	if (!fs.existsSync(path.join(dir, "package.json"))) {
		sh("npm", ["init", "-y"], { cwd: dir, quiet: true });
	}
	if (fs.existsSync(csEntry(dir))) {
		log("code-server は設営済み。取得は飛ばす");
		if (!fs.existsSync(path.join(dir, "node_modules", PLAYWRIGHT_PKG))) {
			sh("npm", ["install", "--ignore-scripts", PLAYWRIGHT_PKG], { cwd: dir });
		}
		return;
	}

	ensureKerberosHeaders();

	log("code-server を取得（postinstall は止める）");
	// postinstall は GitHub から ripgrep のバイナリを取りに行って必ず失敗する
	// （このネットワークは npm レジストリしか通さない）。後で手当てする。
	sh("npm", ["install", "--ignore-scripts", "--unsafe-perm", CODE_SERVER_PKG, PLAYWRIGHT_PKG], {
		cwd: dir,
	});

	const vscodeDir = path.join(dir, "node_modules", "code-server", "lib", "vscode");
	sh("npm", ["install", "--ignore-scripts", "--omit=dev", "--unsafe-perm"], { cwd: vscodeDir });

	// ripgrep: ダウンロードを封じ、環境に入っている rg を流用する
	const rg = findRg();
	if (!rg) {
		throw new Error(
			"rg (ripgrep) が見つかりません。この環境ではバイナリを取得できないので、rg を入れてからやり直してください",
		);
	}
	const rgPkg = path.join(vscodeDir, "node_modules", "@vscode", "ripgrep");
	fs.mkdirSync(path.join(rgPkg, "bin"), { recursive: true });
	fs.mkdirSync(path.join(rgPkg, "lib"), { recursive: true });
	fs.copyFileSync(rg, path.join(rgPkg, "bin", path.basename(rg)));
	fs.chmodSync(path.join(rgPkg, "bin", path.basename(rg)), 0o755);
	fs.writeFileSync(path.join(rgPkg, "lib", "postinstall.js"), "process.exit(0)\n", "utf-8");

	log("ネイティブモジュールをビルド（数分かかる）");
	sh("npm", ["rebuild", "--unsafe-perm"], { cwd: vscodeDir });
	sh("npm", ["install", "--ignore-scripts", "--omit=dev", "--unsafe-perm"], {
		cwd: path.join(vscodeDir, "extensions"),
	});
}

/** mdait を vsix にして code-server へ入れ直す（拡張のコードを直したら up し直せば反映される） */
function packageAndInstallExtension(dir, { fresh }) {
	const repo = repoRoot();
	if (!fs.existsSync(path.join(repo, "node_modules"))) {
		sh("npm", ["ci"], { cwd: repo });
	}
	log("mdait をバンドルして vsix にする");
	sh("npm", ["run", "bundle:dev"], { cwd: repo });

	const vsix = path.join(dir, "mdait.vsix");
	const localVsce = path.join(
		repo,
		"node_modules",
		".bin",
		process.platform === "win32" ? "vsce.cmd" : "vsce",
	);
	const vsceArgs = ["package", "--allow-missing-repository", "--skip-license", "-o", vsix];
	if (fs.existsSync(localVsce)) {
		sh(localVsce, vsceArgs, { cwd: repo });
	} else {
		sh("npx", ["vsce", ...vsceArgs], { cwd: repo });
	}

	const extDir = path.join(dir, "cs-ext");
	const dataDir = path.join(dir, "cs-data");
	if (fresh) {
		// 作り直しのときだけ消す（信頼状態や画面の配置も戻る）
		fs.rmSync(extDir, { recursive: true, force: true });
		fs.rmSync(dataDir, { recursive: true, force: true });
	}
	fs.mkdirSync(extDir, { recursive: true });
	fs.mkdirSync(dataDir, { recursive: true });
	log("code-server へ拡張を入れる");
	sh(process.execPath, [
		csEntry(dir),
		"--extensions-dir",
		extDir,
		"--user-data-dir",
		dataDir,
		"--install-extension",
		vsix,
	]);
}

/**
 * ファイル IPC を有効にする。
 * ブラウザ版には環境変数を渡す手段が無いので、この空ファイルが目印になる
 * （src/extension.ts が .mdait/debug/.ipc-enabled を見て DebugCommandHandler を起こす）。
 * 前回の残りカス（ready / result / command）もここで消す。
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

function pidFile(dir) {
	return path.join(dir, "cs.pid");
}

function browserPidFile(dir) {
	return path.join(dir, "browser.pid");
}

/** 記録しておいた PID を読む（無ければ null） */
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
	} catch {
		return false;
	}
	return true;
}

/** 自分の作業ディレクトリで前に起こしたプロセスだけを止める（pkill -f で広く殺さない） */
function stopRecorded(file) {
	const pid = readPid(file);
	const stopped = stopPid(pid);
	fs.rmSync(file, { force: true });
	return stopped;
}

/**
 * code-server を切り離して起こす。
 * パイプに繋ぐとサーバーごと死に、フォアグラウンドのままだと呼び出し元の終了に道連れになるので、
 * 出力はログファイルへ、プロセスは detached + unref で切り離す（nohup と同じことをする）。
 */
function startServer(dir, ws, port) {
	stopRecorded(pidFile(dir));
	const logFile = path.join(dir, "cs.log");
	const out = fs.openSync(logFile, "a");
	const child = spawn(
		process.execPath,
		[
			csEntry(dir),
			"--auth",
			"none",
			"--bind-addr",
			`127.0.0.1:${port}`,
			"--extensions-dir",
			path.join(dir, "cs-ext"),
			"--user-data-dir",
			path.join(dir, "cs-data"),
			"--disable-telemetry",
			"--disable-update-check",
			ws,
		],
		{ detached: true, stdio: ["ignore", out, out] },
	);
	child.unref();
	fs.writeFileSync(pidFile(dir), String(child.pid), "utf-8");
	log(`起動しました pid=${child.pid} ログ=${logFile}`);
	return child.pid;
}

/** HTTP が応答するまで待つ（プロキシを通さず 127.0.0.1 へ直接繋ぐ） */
function waitHttp(port, timeoutSec = 60) {
	const deadline = Date.now() + timeoutSec * 1000;
	const once = () =>
		new Promise((resolve) => {
			const req = http.request(
				{ host: "127.0.0.1", port, path: "/", method: "GET", agent: false, timeout: 3000 },
				(res) => {
					res.resume();
					resolve(res.statusCode || 0);
				},
			);
			req.on("error", () => resolve(0));
			req.on("timeout", () => {
				req.destroy();
				resolve(0);
			});
			req.end();
		});
	return (async () => {
		while (Date.now() < deadline) {
			const code = await once();
			if (code === 200 || code === 302) return code;
			await new Promise((r) => setTimeout(r, 1000));
		}
		throw new Error(`code-server が応答しません（ポート ${port}）。ログを見てください`);
	})();
}

/**
 * ブラウザを常駐で起こし、ワークスペースのページを開いたままにする。
 * 以後の lab shot はここに繋ぎ直す。
 *
 * ページを開いたままにするのが肝心: code-server はブラウザが1つも繋がっていないと
 * 拡張機能の実行環境（Extension Host）を畳んでしまい、ファイル IPC に返事が来なくなる（実測）。
 */
async function startBrowser(dir, { ws, port }) {
	stopRecorded(browserPidFile(dir));
	const wsFile = path.join(dir, "browser-ws.txt");
	fs.rmSync(wsFile, { force: true });
	const out = fs.openSync(path.join(dir, "browser.log"), "a");
	const child = spawn(process.execPath, [DRIVER, "--serve", "--workspace", ws, "--port", String(port)], {
		detached: true,
		stdio: ["ignore", out, out],
	});
	child.unref();
	fs.writeFileSync(browserPidFile(dir), String(child.pid), "utf-8");
	const deadline = Date.now() + 60000;
	while (Date.now() < deadline) {
		if (fs.existsSync(wsFile)) {
			const endpoint = fs.readFileSync(wsFile, "utf-8").trim();
			if (endpoint) return { pid: child.pid, endpoint };
		}
		if (!alive(child.pid)) break;
		await new Promise((r) => setTimeout(r, 500));
	}
	log("警告: 常駐ブラウザを起こせませんでした。以後は毎回ブラウザを立ち上げます");
	return { pid: null, endpoint: null };
}

/**
 * 設営（初回のみ）→ 拡張の入れ直し → 起動 → 拡張が ready になるまで待つ。
 *
 * @param {object} options
 *   ws     : 用意済みのワークスペース。無ければ wsMode から用意する
 *   wsMode : "tmp" | "repo" | 絶対パス（既定 "tmp"）
 *   port   : 待ち受けポート（既定 8099）
 *   reset  : true なら cs-ext / cs-data も作り直す
 *   readyTimeoutSec : ready 待ちの上限（既定 120 秒）
 */
export async function up(options = {}) {
	const dir = codeServerDir();
	const port = Number(options.port || DEFAULT_PORT);
	const ws =
		options.ws || (await prepareWorkspace({ mode: options.wsMode || "tmp", reset: options.reset }));

	const fresh = !fs.existsSync(csEntry(dir)) || Boolean(options.reset);
	setupCodeServer(dir);
	packageAndInstallExtension(dir, { fresh });

	enableIpc(ws);
	const pid = startServer(dir, ws, port);
	await waitHttp(port, 90);
	if (!alive(pid)) {
		// 応答はあるのに自分のプロセスが死んでいる = 別の code-server がポートを握っている
		const tail = fs.readFileSync(path.join(dir, "cs.log"), "utf-8").split("\n").slice(-5).join("\n");
		throw new Error(
			`起こした code-server が落ちました（ポート ${port} は別のものが使っているかもしれません）。\n${tail}`,
		);
	}
	log(`HTTP 応答あり: http://127.0.0.1:${port}/?folder=${encodeURIComponent(ws)}`);

	// 画面を開いて拡張を動かし、ready ファイルができるまで待つ。
	// ブラウザとページは常駐させる（閉じると Extension Host ごと畳まれてしまう）。
	const browser = await startBrowser(dir, { ws, port });
	if (!browser.endpoint) {
		// 常駐に失敗したときの保険。この場合はページが閉じると IPC が止まる
		const session = await connect({ workspace: ws, port, shotsDir: options.shotsDir });
		try {
			await session.openMdait();
			await waitReady(ws, options.readyTimeoutSec || 120);
		} finally {
			await session.close();
		}
		log(
			"警告: ブラウザを常駐できませんでした。画面を閉じると拡張も止まり ready ファイルも消えるため、" +
				"lab run のたびに画面を開き直す必要があります",
		);
	} else {
		try {
			await waitReady(ws, options.readyTimeoutSec || 120);
		} catch (e) {
			throw new Error(
				`${e.message}\n画面側のログを見てください: ${path.join(dir, "browser.log")}`,
			);
		}
	}
	log("拡張の ready を確認しました");

	return {
		pid,
		port,
		ws,
		browserPid: browser.pid,
		browserWs: browser.endpoint,
		logFile: path.join(dir, "cs.log"),
		url: `http://127.0.0.1:${port}/?folder=${encodeURIComponent(ws)}`,
	};
}

/** 自分の作業ディレクトリで起こしたものだけを PID で止める */
export async function down(session = {}) {
	const dir = codeServerDir();
	const stopped = [];
	if (session.hostPid && stopPid(session.hostPid)) {
		stopped.push(`code-server(${session.hostPid})`);
		fs.rmSync(pidFile(dir), { force: true });
	} else if (stopRecorded(pidFile(dir))) {
		stopped.push("code-server");
	}
	if (session.browserPid && stopPid(session.browserPid)) {
		stopped.push(`browser(${session.browserPid})`);
		fs.rmSync(browserPidFile(dir), { force: true });
	} else if (stopRecorded(browserPidFile(dir))) {
		stopped.push("browser");
	}
	fs.rmSync(path.join(dir, "browser-ws.txt"), { force: true });
	fs.rmSync(path.join(dir, "ui-request.json"), { force: true });
	fs.rmSync(path.join(dir, "ui-result.json"), { force: true });
	log(stopped.length ? `止めました: ${stopped.join(", ")}` : "止めるものはありませんでした");
}

/** 今どうなっているかを一行で */
export async function status(session = {}) {
	const dir = codeServerDir();
	const pid = session.hostPid || readPid(pidFile(dir));
	const port = session.hostPort || DEFAULT_PORT;
	const ws = session.ws || "(不明)";
	const ready = ws !== "(不明)" && fs.existsSync(ipcPaths(ws).readyFile);
	const browserPid = session.browserPid || readPid(browserPidFile(dir));
	return `code-server pid=${pid ?? "なし"} ${alive(pid) ? "動作中" : "停止"} port=${port} ws=${ws} 常駐画面=${alive(browserPid) ? `あり(${browserPid})` : "なし"} ready=${ready ? "あり" : "なし"}`;
}
