#!/usr/bin/env node
/*
 * ブラウザ版 VS Code（code-server）を Playwright で操作するためのヘルパ。
 *
 * 役割の線引き:
 *   - コマンドの実行はファイル IPC（<ws>/.mdait/debug/command.json）を使う。
 *   - ここは「画面を見る」ための道具。見た目の確認・スクリーンショット・
 *     UI にしか出ない文言（通知・ダイアログ）の読み取りに使う。
 *
 * playwright-core は作業ディレクトリ（<LAB_DIR>/code-server/node_modules）から
 * 読み込む。リポジトリの node_modules には依存しない。
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { LAB_DIR, readSession } from "../lib/session.mjs";

const require_ = createRequire(import.meta.url);

/** code-server 一式を置く作業ディレクトリ */
export function codeServerDir() {
	return path.join(LAB_DIR, "code-server");
}

/** 立ち上げっぱなしのブラウザの接続先を書いておくファイル */
export function browserWsFile() {
	return path.join(codeServerDir(), "browser-ws.txt");
}

/** この環境に同梱されている Chromium（ダウンロードはできないので使い回す） */
export const CHROMIUM_PATH = process.env.MDAIT_LAB_CHROMIUM || "/opt/pw-browsers/chromium";

/** 既定のポート。code-server 側と同じ既定値を使う */
export const DEFAULT_PORT = Number(process.env.MDAIT_LAB_PORT || 8099);

function loadChromium() {
	const pkgDir = path.join(codeServerDir(), "node_modules", "playwright-core");
	if (!fs.existsSync(pkgDir)) {
		throw new Error(
			`playwright-core が見つかりません: ${pkgDir}\n` +
				"先に `node scripts/lab/lab.mjs up --host code-server` で設営してください",
		);
	}
	const { chromium } = require_(pkgDir);
	return chromium;
}

function readBrowserWs() {
	try {
		const text = fs.readFileSync(browserWsFile(), "utf-8").trim();
		return text || null;
	} catch {
		return null;
	}
}

/**
 * code-server に接続し、mdait の画面を見られる状態のセッションを返す。
 *
 * - 立ち上げっぱなしのブラウザ（up が起こしたもの）があれば繋ぎ直す。無ければ自分で起こす。
 * - ワークスペース信頼のダイアログを承認する。
 * - code-server 独自の Chat 補助バーを閉じて、スクリーンショットの余計な要素を減らす。
 *
 * @param {object} opts
 *   workspace: 開くフォルダ（省略時はセッションの ws）
 *   port     : code-server のポート（省略時はセッションの hostPort）
 *   shotsDir : スクリーンショットの既定の保存先
 *   browserWs: 繋ぎ直す先（省略時はセッション／ファイルから読む）
 *   fresh    : true なら既存ページを再利用せず新しいページを開く
 */
export async function connect(opts = {}) {
	const session = readSession() || {};
	const workspace = opts.workspace || session.ws;
	if (!workspace) {
		throw new Error("開くワークスペースが分かりません（workspace を渡すか lab up を先に実行）");
	}
	const port = Number(opts.port || session.hostPort || DEFAULT_PORT);
	const shotsDir =
		opts.shotsDir ||
		(session.runDir ? path.join(session.runDir, "shots") : path.join(LAB_DIR, "shots"));
	const chromium = loadChromium();

	// 1) すでに開いているブラウザに繋ぐ。駄目なら自分で起こす（その場合は自分で閉じる）
	const endpoint = opts.browserWs || session.browserWs || readBrowserWs();
	let browser = null;
	let ownsBrowser = false;
	if (endpoint) {
		try {
			browser = await chromium.connect(endpoint, { timeout: 15000 });
		} catch {
			browser = null;
		}
	}
	if (!browser) {
		browser = await chromium.launch({
			executablePath: CHROMIUM_PATH,
			args: ["--no-sandbox"],
		});
		ownsBrowser = true;
	}

	// 2) 開いているページがあれば使い回す（開き直しの待ち時間を減らすため）。
	// 別プロセスから繋ぎ直した場合、Playwright は接続ごとにページを分けるので実際には
	// 作り直しになる。それでもブラウザ本体は起動済みなので開くのは速い。
	const url = `http://127.0.0.1:${port}/?folder=${encodeURIComponent(workspace)}`;
	let page = null;
	if (!opts.fresh) {
		for (const ctx of browser.contexts()) {
			for (const p of ctx.pages()) {
				if (!p.isClosed() && p.url().startsWith(`http://127.0.0.1:${port}/`)) {
					page = p;
					break;
				}
			}
			if (page) break;
		}
	}
	const reused = Boolean(page);
	if (!page) {
		const context = await browser.newContext({
			viewport: opts.viewport || { width: 1440, height: 900 },
		});
		page = await context.newPage();
		await page.goto(url, { waitUntil: "domcontentloaded" });
	}
	await page.waitForSelector(".monaco-workbench", { timeout: 60000 });

	if (!reused) {
		// ワークスペース信頼のダイアログ（信頼済みなら出ない）
		try {
			const trust = page.locator(".dialog-buttons a", { hasText: /^Yes/i });
			await trust.waitFor({ timeout: 8000 });
			await trust.click();
		} catch {
			// 出なければ何もしない
		}
		// code-server の Chat 補助バーを畳む
		try {
			const aux = page.locator(".part.auxiliarybar");
			if (await aux.isVisible({ timeout: 2000 })) {
				await page.keyboard.press("Control+Alt+B");
				await page.waitForTimeout(500);
			}
		} catch {
			// 補助バーが無ければ何もしない
		}
	}

	/**
	 * スクリーンショットを保存する。
	 * @param {string} name 拡張子なしの名前
	 * @param {string} [dir] 保存先。省略時は run ディレクトリの shots/
	 * @returns {Promise<string>} 保存したファイルのパス
	 */
	const shot = async (name, dir) => {
		const outDir = dir || shotsDir;
		fs.mkdirSync(outDir, { recursive: true });
		const file = path.join(outDir, `${name}.png`);
		await page.screenshot({ path: file });
		return file;
	};

	/** アクティビティバーの mdait ビューを開く（拡張が動き出すのを待つ） */
	const openMdait = async () => {
		const icon = page.locator('.activitybar .action-item a[aria-label*="mdait" i]');
		await icon.first().waitFor({ timeout: 60000 });
		await icon.first().click();
		await page.waitForTimeout(2000);
	};

	/**
	 * コマンドパレットに文字を打ってコマンドを実行する。
	 *
	 * 注意: コマンドの実行は原則ファイル IPC（lab run）を使うこと。
	 * こちらは QuickPick の選択やマウス操作でしか起きないこと（候補一覧の見え方、
	 * 途中でキャンセルしたときの挙動など）を確かめる時だけ使う。
	 */
	const runCommand = async (query) => {
		await page.keyboard.press("F1");
		await page.waitForTimeout(500);
		await page.keyboard.type(query, { delay: 15 });
		await page.waitForTimeout(800);
		await page.keyboard.press("Enter");
	};

	/** サイドバーのツリー行を文字で探す */
	const treeRow = (text) => page.locator(".part.sidebar .monaco-list-row", { hasText: text });

	/**
	 * 画面右下の通知（トースト）を読む。目視だけに頼らず文言を機械的に拾うため。
	 * @returns {Promise<Array<{text: string, buttons: string[]}>>}
	 */
	const notifications = async () => {
		const toasts = page.locator(".notifications-toasts .notification-toast");
		const count = await toasts.count();
		const out = [];
		for (let i = 0; i < count; i++) {
			const toast = toasts.nth(i);
			const text = ((await toast.locator(".notification-list-item-message").innerText().catch(() => "")) || (await toast.innerText().catch(() => ""))).trim();
			const buttons = (
				await toast.locator(".monaco-button, .notification-list-item-buttons-container a").allInnerTexts()
			)
				.map((s) => s.trim())
				.filter(Boolean);
			out.push({ text, buttons });
		}
		return out;
	};

	/**
	 * 前面のダイアログを読む。出ていなければ null。
	 * @returns {Promise<{message: string, detail: string, buttons: string[]} | null>}
	 */
	const dialog = async () => {
		const box = page.locator(".monaco-dialog-box");
		if ((await box.count()) === 0) return null;
		const message = (await box.locator(".dialog-message-text").innerText().catch(() => "")).trim();
		const detail = (await box.locator(".dialog-message-detail").innerText().catch(() => "")).trim();
		const buttons = (await box.locator(".dialog-buttons a").allInnerTexts())
			.map((s) => s.trim())
			.filter(Boolean);
		return { message, detail, buttons };
	};

	/** ダイアログのボタンを文字で押す（AI 利用の確認 "Proceed" など） */
	const clickDialogButton = async (text) => {
		const button = page.locator(".monaco-dialog-box .dialog-buttons a", { hasText: text });
		await button.first().waitFor({ timeout: 10000 });
		await button.first().click();
	};

	/**
	 * 後片付け。
	 * 自分で起こしたブラウザなら閉じる。繋ぎ直した場合は切断するだけで、
	 * 常駐ブラウザは開いたままになる（自分が開いたページだけが閉じる）。
	 */
	const close = async () => {
		await browser.close().catch(() => {});
	};

	return {
		browser,
		page,
		workspace,
		port,
		shotsDir,
		reused,
		ownsBrowser,
		shot,
		openMdait,
		runCommand,
		treeRow,
		notifications,
		dialog,
		clickDialogButton,
		close,
	};
}

/** 常駐ページへの頼みごとに使うファイル */
export function uiPaths() {
	const dir = codeServerDir();
	return {
		requestFile: path.join(dir, "ui-request.json"),
		resultFile: path.join(dir, "ui-result.json"),
	};
}

/**
 * 常駐ページに用事を頼む。
 *
 * 見る操作は必ずここを通すこと。別に画面を開くと、その画面でも拡張が動き出し、
 * 同じ command.json を2つの拡張が奪い合う。さらに画面を閉じたときに ready ファイルが
 * 消えてしまう（拡張は終了時に自分で消す）。画面は1つに保つのが安全（実測）。
 *
 * @param {"shot"|"notifications"|"dialog"|"click-dialog"|"open-mdait"|"run-command"|"tree-rows"|"url"|"reload"} action
 */
export async function ask(action, args = {}, { timeoutSec = 60 } = {}) {
	const { requestFile, resultFile } = uiPaths();
	if (!fs.existsSync(browserWsFile())) {
		throw new Error("常駐ブラウザがいません（lab up --host code-server を先に実行）");
	}
	fs.rmSync(resultFile, { force: true });
	const id = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
	fs.writeFileSync(requestFile, JSON.stringify({ id, action, args }), "utf-8");
	const deadline = Date.now() + timeoutSec * 1000;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 200));
		let out = null;
		try {
			out = JSON.parse(fs.readFileSync(resultFile, "utf-8"));
		} catch {
			continue;
		}
		if (out.id !== id) continue;
		fs.rmSync(resultFile, { force: true });
		if (!out.ok) throw new Error(`常駐ページでの失敗（${action}）: ${out.error}`);
		return out.value;
	}
	throw new Error(`常駐ページが応答しません（${action}）`);
}

/**
 * スクリーンショットを撮る。lab shot の実体。
 *
 * 呼び方は2通り。lab.mjs は `shot(session, 名前)` で呼ぶ（保存先はその run の shots/）。
 * 手で使うときは `shot(名前, 保存先)` でもよい。
 * 常駐ページがいればそこで撮る。いなければ一時的に画面を開いて撮る（下の注意を参照）。
 */
export async function shot(first, second) {
	const isSession = Boolean(first) && typeof first === "object";
	const session = isSession ? first : null;
	const name = isSession ? second : first;
	const dir = isSession
		? session.runDir
			? path.join(session.runDir, "shots")
			: undefined
		: second;
	try {
		return await ask("shot", { name, dir });
	} catch (e) {
		console.error(`常駐ページを使えませんでした（${e.message}）。一時的に画面を開いて撮ります`);
		console.error("注意: 一時的な画面を閉じると ready ファイルが消えます（拡張が終了時に消すため）");
		const opened = await connect({
			workspace: session?.ws,
			port: session?.hostPort,
			shotsDir: dir,
		});
		try {
			return await opened.shot(name, dir);
		} finally {
			await opened.close();
		}
	}
}

/**
 * ブラウザとページを立ち上げっぱなしにする常駐モード。
 * `node scripts/lab/ui/driver.mjs --serve --workspace <ws> --port <port>` で起動し、
 * 接続先を browser-ws.txt に書く。code-server ホストの up が裏で起こすので、普段は直接使わない。
 *
 * ページを開いたままにするのが肝心。code-server はブラウザが1つも繋がっていないと
 * 拡張機能の実行環境（Extension Host）を畳んでしまい、ファイル IPC に返事が来なくなる（実測）。
 */
async function serve(argv) {
	const chromium = loadChromium();
	const server = await chromium.launchServer({
		executablePath: CHROMIUM_PATH,
		args: ["--no-sandbox"],
	});
	const file = browserWsFile();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, server.wsEndpoint(), "utf-8");
	console.log(`ブラウザを起こしました: ${server.wsEndpoint()}`);

	let keeper = null;
	const workspace = argv.workspace;
	if (workspace) {
		keeper = await connect({
			workspace,
			port: argv.port,
			browserWs: server.wsEndpoint(),
			fresh: true,
		});
		await keeper.openMdait();
		console.log(`常駐ページを開きました: ${workspace}`);
		serveRequests(keeper);
	}

	const stop = async () => {
		try {
			fs.unlinkSync(file);
		} catch {
			// 既に消えていれば何もしない
		}
		if (keeper) await keeper.close().catch(() => {});
		await server.close().catch(() => {});
		process.exit(0);
	};
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
	// 何もしないタイマーで常駐させる
	setInterval(() => {}, 1 << 30);
}

/** 常駐ページへの頼まれごとを受け付ける（ファイル越しの簡単なやり取り） */
async function serveRequests(keeper) {
	const { requestFile, resultFile } = uiPaths();
	fs.rmSync(requestFile, { force: true });
	fs.rmSync(resultFile, { force: true });
	for (;;) {
		await new Promise((r) => setTimeout(r, 200));
		let request = null;
		try {
			request = JSON.parse(fs.readFileSync(requestFile, "utf-8"));
		} catch {
			continue; // 無い／書きかけならまた次
		}
		fs.rmSync(requestFile, { force: true });
		let out;
		try {
			out = { id: request.id, ok: true, value: await handleRequest(keeper, request) };
		} catch (e) {
			out = { id: request.id, ok: false, error: String((e && e.message) || e) };
		}
		fs.writeFileSync(resultFile, JSON.stringify(out), "utf-8");
	}
}

async function handleRequest(keeper, request) {
	const a = request.args || {};
	switch (request.action) {
		case "shot":
			return await keeper.shot(a.name, a.dir);
		case "notifications":
			return await keeper.notifications();
		case "dialog":
			return await keeper.dialog();
		case "click-dialog":
			return await keeper.clickDialogButton(a.text);
		case "open-mdait":
			return await keeper.openMdait();
		case "run-command":
			return await keeper.runCommand(a.query);
		case "tree-rows":
			return await keeper.page.locator(".part.sidebar .monaco-list-row").allInnerTexts();
		case "url":
			return keeper.page.url();
		case "reload":
			await keeper.page.reload({ waitUntil: "domcontentloaded" });
			await keeper.page.waitForSelector(".monaco-workbench", { timeout: 60000 });
			return true;
		default:
			throw new Error(`知らない頼まれごとです: ${request.action}`);
	}
}

/** --serve 用の簡単な引数読み取り */
function parseArgv(args) {
	const out = {};
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--workspace") out.workspace = args[++i];
		else if (args[i] === "--port") out.port = Number(args[++i]);
	}
	return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
	if (process.argv.includes("--serve")) {
		serve(parseArgv(process.argv.slice(2))).catch((e) => {
			console.error(e);
			process.exit(1);
		});
	} else {
		console.log("使い方: node scripts/lab/ui/driver.mjs --serve [--workspace <ws>] [--port <port>]");
	}
}
