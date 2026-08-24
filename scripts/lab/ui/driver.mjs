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
import { ipcPaths } from "../lib/ipc.mjs";
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
 * ツリーの行の名前が、探している名前かどうかを見る。
 *
 * 訳文側の行のラベルには**翻訳の進み具合が入る**（`status-item-tree.ts` が
 * `` `${dirName} (${translated}/${total})` `` を組み立てる）。そのため `en` と探しても
 * 画面上の名前は `en (5/90)` で、そのまま比べると当たらない。かといって前方一致にすると
 * `child` が `child2` にも当たってしまう。**数え上げの括弧が続くときだけ**同じ行と見なす。
 *
 * @param {string} name 画面に出ている名前
 * @param {string} label 探している名前
 */
function matchesRowName(name, label) {
	return name === label || name.startsWith(`${label} (`);
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
	 * サイドバーのツリーを機械可読で読む。
	 *
	 * 見た目でしか分からないこと（回転アイコン・色・字下げの深さ）を文字にして持ち出すためのもの。
	 * アイコンは codicon の class 名がそのまま状態の名前になっている（`sync~spin` は
	 * `codicon-sync codicon-modifier-spin` として出る）。
	 *
	 * @returns {Promise<Array<{label: string, description: string, icon: string, spinning: boolean, aria: string, depth: number}>>}
	 */
	const treeItems = async () => {
		return await page.locator(".part.sidebar .monaco-list-row").evaluateAll((rows) =>
			rows.map((row) => {
				const icon = row.querySelector(".custom-view-tree-node-item-icon, .monaco-icon-label > .codicon");
				const cls = icon ? icon.className : "";
				const name = row.querySelector(".monaco-icon-name-container .label-name");
				const desc = row.querySelector(".monaco-icon-description-container .label-description");
				const indent = row.querySelector(".monaco-tl-indent");
				return {
					label: (name?.textContent || row.textContent || "").trim(),
					description: (desc?.textContent || "").trim(),
					icon: (cls.match(/codicon-[\w-]+/g) || []).join(" "),
					spinning: cls.includes("codicon-modifier-spin"),
					aria: (row.getAttribute("aria-label") || "").trim(),
					depth: Number(row.getAttribute("aria-level") || indent?.childElementCount || 0),
				};
			}),
		);
	};

	/**
	 * ツリーを畳まれているところまで開く。
	 *
	 * 開かないと**根しか見えない**（実測: 同期直後は `ja` と `en` の2行だけ）。
	 * 折り畳みは行の `aria-expanded="false"` で見分けられるので、それが無くなるまで押す。
	 * 深さが青天井にならないよう回数で止める。
	 *
	 * @param {number} rounds 押し広げる回数の上限
	 * @returns {Promise<number>} 開いた行の数
	 */
	const expandTree = async (rounds = 6) => {
		let opened = 0;
		for (let i = 0; i < rounds; i++) {
			const collapsed = page.locator('.part.sidebar .monaco-list-row[aria-expanded="false"]');
			const count = await collapsed.count();
			if (count === 0) break;
			// **下から順に押す。** 上から押すと、開いて増えた子がすぐ次の「最初の畳まれた行」に
			// なるため、深さ方向へ潜り続けて隣の枝（en）へ永久に辿り着かない（実測: 91回
			// 押しても en が畳まれたままだった）。下から押せば上の行の位置は動かない。
			for (let n = count - 1; n >= 0; n--) {
				const row = page.locator('.part.sidebar .monaco-list-row[aria-expanded="false"]').nth(n);
				if ((await row.count()) === 0) continue;
				await row.click({ timeout: 5000 }).catch(() => {});
				opened += 1;
				await page.waitForTimeout(150);
			}
			await page.waitForTimeout(500);
		}
		return opened;
	};

	/**
	 * ツリーの1行を開く／畳む。
	 *
	 * 全部開くと**行が画面からはみ出す**。VS Code のリストは見えている行しか DOM に置かないので、
	 * はみ出した行は読むことも撮ることもできない（実測: 翻訳中に回転していたのは、
	 * 見えていた `en (5/90)` の1行だけだった）。見たい枝だけを開き、要らない枝は畳む。
	 *
	 * @param {string} label 行の名前。翻訳の進み具合はラベル自体に入るので（`en (5/90)`）、
	 *   `en` のように**数え上げを外した名前**でも当たる（`matchesRowName` を参照）
	 * @param {boolean} expanded true なら開く、false なら畳む
	 * @returns {Promise<boolean>} 目当ての行が見つかったか。**見つからなければ false を返す**
	 *   （呼び手はここを見ること。黙って何もしないと、開いたつもりの枝が畳まれたままになる）
	 */
	const setRowExpanded = async (label, expanded = true) => {
		const rows = page.locator(".part.sidebar .monaco-list-row");
		const count = await rows.count();
		for (let i = 0; i < count; i++) {
			const row = rows.nth(i);
			const name = (
				await row
					.locator(".monaco-icon-name-container .label-name")
					.first()
					.textContent()
					.catch(() => "")
			)?.trim();
			if (!name || !matchesRowName(name, label)) continue;
			const state = await row.getAttribute("aria-expanded").catch(() => null);
			if (state === null) return true; // 子を持たない行。開くも畳むも無い
			if ((state === "true") !== expanded) {
				await row.scrollIntoViewIfNeeded().catch(() => {});
				await row.click({ timeout: 5000 });
				await page.waitForTimeout(600);
			}
			return true;
		}
		return false;
	};

	/**
	 * いま開いているエディタの CodeLens を機械可読で読む。
	 *
	 * CodeLens は**実 Extension Host でしか出ない**（headless では provider ごと動かない）。
	 * ボタンの文字は `$(check) Mark as Translated` のようにアイコン記法を含むが、
	 * 画面ではアイコンに置き換わるので、ここで拾えるのは文字の部分だけになる。
	 *
	 * @returns {Promise<Array<{line: number, buttons: string[]}>>} 行の上から順
	 */
	const codeLenses = async () => {
		const raw = await page.locator(".monaco-editor .codelens-decoration").evaluateAll((nodes) =>
			nodes.map((node) => ({
				top: node.parentElement?.getBoundingClientRect().top ?? 0,
				buttons: Array.from(node.querySelectorAll("a"))
					.map((a) => (a.textContent || "").trim())
					.filter(Boolean),
			})),
		);
		return raw
			.filter((entry) => entry.buttons.length > 0)
			.sort((a, b) => a.top - b.top)
			.map((entry, i) => ({ line: i + 1, buttons: entry.buttons }));
	};

	/**
	 * ファイルを開く（クイックオープン）。
	 *
	 * コマンドの実行は IPC を使う約束だが、**ファイルを開くのは IPC では頼めない**
	 * （`DebugCommandHandler` は `mdait.` で始まるコマンドしか受け付けない）。
	 * CodeLens もホバーも「エディタが開いている」ことが前提なので、ここだけは画面を操作する。
	 *
	 * @param {string} relPath ワークスペースから見た相対パス
	 */
	const openFile = async (relPath) => {
		// Ctrl+P は使わない。ブラウザ側に取られて quick input が出ないことがある（実測）。
		// F1（コマンドパレット）は確実に開くので、頭の ">" を消して**ファイル検索**へ切り替える。
		await page.keyboard.press("F1");
		await page.waitForSelector(".quick-input-widget", { timeout: 15000 });
		await page.keyboard.press("Control+A");
		await page.keyboard.type(relPath, { delay: 10 });
		await page.waitForTimeout(1500);
		await page.keyboard.press("Enter");
		const name = relPath.split("/").pop();
		await page.waitForSelector(`.tabs-container .tab[aria-label*="${name}"]`, { timeout: 20000 });
		// CodeLens は provider が返してから描かれるので、開いた直後には無い
		await page.waitForTimeout(2500);
		return name;
	};

	/**
	 * 開いているエディタを全部閉じる。
	 *
	 * コマンドパレットに文字を打つ方法は当てにしない（候補の並びで別のコマンドを引くことがある）。
	 * タブの×を直に押す。前の実験で開いたタブは**画面の状態として保存されている**ので、
	 * 立て直しても復活する（実測: reset した直後の初期状態の写しに前回のタブが写っていた）。
	 *
	 * @returns {Promise<number>} 閉じたタブの数
	 */
	const closeEditors = async () => {
		let closed = 0;
		for (let i = 0; i < 20; i++) {
			const closer = page.locator(".tabs-container .tab .codicon-close, .tabs-container .tab .tab-close a").first();
			if ((await closer.count()) === 0) break;
			await closer.click({ timeout: 5000 }).catch(() => {});
			closed += 1;
			await page.waitForTimeout(300);
		}
		await page.waitForTimeout(500);
		return closed;
	};

	/**
	 * 画面右下の通知（トースト）を読む。目視だけに頼らず文言を機械的に拾うため。
	 * @returns {Promise<Array<{text: string, buttons: string[], level: string}>>}
	 */
	const notifications = async () => {
		// **innerText() を使わない。** 見つからない要素に対する待ち合わせが働き、
		// 無いだけで既定の 30 秒ぶら下がる。見張りは待ち行列を握ったままなので、
		// その間ほかの頼まれごとが全部止まる（実測で `dialog-policy` が 60 秒応答しなかった）。
		// 一度の evaluateAll で読み切れば、無いものは無いまま即座に返る。
		return await page.locator(".notifications-toasts .notification-toast").evaluateAll((toasts) =>
			toasts.map((toast) => {
				const message = toast.querySelector(".notification-list-item-message");
				const icon = toast.querySelector(".notification-list-item-icon");
				const cls = icon ? icon.className : "";
				return {
					text: ((message || toast).textContent || "").trim(),
					buttons: Array.from(
						toast.querySelectorAll(".monaco-button, .notification-list-item-buttons-container a"),
					)
						.map((b) => (b.textContent || "").trim())
						.filter(Boolean),
					level: cls.includes("error") ? "error" : cls.includes("warning") ? "warning" : "info",
				};
			}),
		);
	};

	/**
	 * 前面のダイアログを読む。出ていなければ null。
	 * primary は「人が主に押すことになるボタン」（VS Code は控えめな方に secondary の印を付ける）。
	 * @returns {Promise<{message: string, detail: string, buttons: string[], primary: string|null, level: string} | null>}
	 */
	const dialog = async () => {
		// notifications と同じ理由で innerText() を使わない。確認ダイアログには
		// 補足（detail）が無いものがあり、待ち合わせに掛かると 1 回読むのに 30 秒かかる。
		const boxes = await page.locator(".monaco-dialog-box").evaluateAll((nodes) =>
			nodes.map((box) => {
				const buttons = Array.from(box.querySelectorAll(".dialog-buttons .monaco-button")).map((b) => ({
					text: (b.textContent || "").trim(),
					secondary: b.classList.contains("secondary"),
				}));
				const icon = box.querySelector(".dialog-icon");
				const cls = icon ? icon.className : "";
				return {
					message: (box.querySelector(".dialog-message-text")?.textContent || "").trim(),
					detail: (box.querySelector(".dialog-message-detail")?.textContent || "").trim(),
					buttons: buttons.map((b) => b.text).filter(Boolean),
					primary: (buttons.find((b) => !b.secondary) || buttons[0] || {}).text || null,
					level: cls.includes("error") ? "error" : cls.includes("warning") ? "warning" : "info",
				};
			}),
		);
		return boxes[0] ?? null;
	};

	/**
	 * 通知（トースト）のボタンを文字で押す。
	 * mdait には「ボタンを押すまで終わらない通知」があるため、放っておくとコマンドが
	 * 終わらないことがある（実測: 対がないファイルへの trans は通知を出したまま running のまま）。
	 */
	const clickNotificationButton = async (text) => {
		const button = page.locator(".notifications-toasts .notification-toast .monaco-button", {
			hasText: text,
		});
		await button.first().waitFor({ timeout: 10000 });
		await button.first().click();
	};

	/** 文言で指した通知を1つだけ閉じる（ボタンは押さない） */
	const dismissNotificationByText = async (text) => {
		const toast = page
			.locator(".notifications-toasts .notification-toast", { hasText: text })
			.first();
		await toast.locator(".codicon-notifications-clear").first().click({ timeout: 5000 });
	};

	/** 通知を閉じる（ボタンを押さずに片付ける） */
	const dismissNotifications = async () => {
		const closers = page.locator(
			".notifications-toasts .notification-toast .codicon-notifications-clear",
		);
		const count = await closers.count();
		for (let i = count - 1; i >= 0; i--) {
			await closers.nth(i).click({ timeout: 5000 }).catch(() => {});
		}
		return count;
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
		treeItems,
		expandTree,
		setRowExpanded,
		codeLenses,
		openFile,
		closeEditors,
		notifications,
		clickNotificationButton,
		dismissNotificationByText,
		dismissNotifications,
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
 * @param {"shot"|"notifications"|"click-notification"|"dismiss-notifications"|"dialog"|"click-dialog"|"open-mdait"|"run-command"|"tree-rows"|"url"|"reload"} action
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
 * 常駐ページが控えた「確認ダイアログ・止まっていた通知」を受け取り、控えを空にする。
 *
 * headless ホストは vscode シムが同じことを控えて result.json の `dialogs` に載せる。
 * 実ホストでは拡張機能が result.json を書くのでこちらから足せない。そこで lab run が
 * 結果を受け取ったあとに、これを呼んで合流させる（形は headless と同じ）。
 *
 * @returns {Promise<Array<{level: string, modal: boolean, message: string, buttons: string[], answered: string|null, dismissed?: boolean}>>}
 */
export async function drainDialogs() {
	try {
		return (await ask("drain-dialogs", {}, { timeoutSec: 15 })) ?? [];
	} catch {
		// 常駐ページがいなければ控えも無い
		return [];
	}
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
	/** 見張りが控えた確認ダイアログ・止まっていた通知（drain-dialogs で持ち出す） */
	const screenLog = [];
	/**
	 * 見張りの答え方。`MDAIT_LAB_DIALOG=no` で始めれば最初から答えない。
	 * 走らせたまま `dialog-policy` で切り替えられる（ダイアログを撮るには置き去りにする必要があるが、
	 * 環境変数は起動時にしか読めないため）。**変える側は必ず元へ戻すこと** — 戻し忘れると
	 * 以後のコマンドが誰にも答えてもらえず、返らないまま止まる。
	 */
	const policy = { declineAll: process.env.MDAIT_LAB_DIALOG === "no" };
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
		const queue = createQueue();
		serveRequests(keeper, queue, screenLog, policy);
		watchScreen(keeper, workspace, queue, screenLog, policy);
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
async function serveRequests(keeper, queue, screenLog, policy) {
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
			out = {
				id: request.id,
				ok: true,
				value: await queue(() => handleRequest(keeper, request, screenLog, policy)),
			};
		} catch (e) {
			out = { id: request.id, ok: false, error: String((e && e.message) || e) };
		}
		fs.writeFileSync(resultFile, JSON.stringify(out), "utf-8");
	}
}

async function handleRequest(keeper, request, screenLog, policy) {
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
		case "click-notification":
			return await keeper.clickNotificationButton(a.text);
		case "dismiss-notifications":
			return await keeper.dismissNotifications();
		case "open-mdait":
			return await keeper.openMdait();
		case "run-command":
			return await keeper.runCommand(a.query);
		case "tree-rows":
			return await keeper.page.locator(".part.sidebar .monaco-list-row").allInnerTexts();
		case "tree-items":
			return await keeper.treeItems();
		case "expand-tree":
			return await keeper.expandTree(a.rounds);
		case "set-row-expanded":
			return await keeper.setRowExpanded(a.label, a.expanded !== false);
		case "codelens":
			return await keeper.codeLenses();
		case "open-file":
			return await keeper.openFile(a.path);
		case "close-editors":
			return await keeper.closeEditors();
		case "dialog-policy":
			// 見張りの答え方を走らせたまま切り替える。ダイアログを撮りたいときは "decline" にして
			// 置き去りにし、撮ってから自分で押す（環境変数は起動時にしか読めないため必要）
			if (a.policy === "answer" || a.policy === "decline") policy.declineAll = a.policy === "decline";
			return policy.declineAll ? "decline" : "answer";
		case "url":
			return keeper.page.url();
		case "drain-dialogs": {
			const out = screenLog.slice();
			screenLog.length = 0;
			return out;
		}
		case "reload":
			await keeper.page.reload({ waitUntil: "domcontentloaded" });
			await keeper.page.waitForSelector(".monaco-workbench", { timeout: 60000 });
			return true;
		default:
			throw new Error(`知らない頼まれごとです: ${request.action}`);
	}
}

/**
 * ページを触る用事を1つずつ順番に行うための待ち行列。
 * 見張りと頼まれごとが同時に同じページを触ると取り違えるため。
 */
function createQueue() {
	let tail = Promise.resolve();
	return (job) => {
		const next = tail.then(job, job);
		tail = next.then(
			() => {},
			() => {},
		);
		return next;
	};
}

/** いま命令が動いている最中かどうか（動いていない間は通知に手を出さない） */
function commandInFlight(ws) {
	const { commandFile, resultFile } = ipcPaths(ws);
	if (fs.existsSync(commandFile)) return true;
	try {
		return JSON.parse(fs.readFileSync(resultFile, "utf-8")).status === "running";
	} catch {
		return false;
	}
}

/**
 * 画面を見張り、命令が止まらないように代わりに答える。headless の vscode シムと同じ考え方。
 *
 * - 確認のダイアログ: **主たるボタン**（VS Code が控えめな方に付ける secondary の印が無い方）を押す。
 *   エラーのダイアログのボタンは「ログを開く」など別の操作なので押さない。
 * - ボタン付きの通知: 押すと別の仕事が始まってしまうので**押さずに閉じる**。
 *   命令が動いている最中だけ手を出す（普段の目視評価で通知が消えては困るため）。
 * - どちらも**黙ってやらない**。控えて drain-dialogs で持ち出せるようにする。
 * - `MDAIT_LAB_DIALOG=no` のときはどれにも答えない（取り消し側を試したいとき用）。
 */
async function watchScreen(keeper, ws, queue, screenLog, policy) {
	const firstSeen = new Map();
	const noticed = new Set();
	let lastUntouched = null;
	for (;;) {
		await new Promise((r) => setTimeout(r, 500));
		try {
			const declineAll = policy.declineAll;
			const box = await queue(() => keeper.dialog());
			if (box && box.buttons.length > 0) {
				const decline = declineAll || box.level === "error";
				const answer = decline ? null : box.primary;
				const message = [box.message, box.detail].filter(Boolean).join(" / ");
				if (answer) {
					await queue(() => keeper.clickDialogButton(answer));
					screenLog.push({
						level: box.level,
						modal: true,
						message,
						buttons: box.buttons,
						answered: answer,
					});
					console.log(`確認ダイアログに「${answer}」と答えました: ${message.slice(0, 60)}`);
				} else if (lastUntouched !== message) {
					lastUntouched = message;
					screenLog.push({
						level: box.level,
						modal: true,
						message,
						buttons: box.buttons,
						answered: null,
					});
					console.log(`確認ダイアログに答えませんでした: ${message.slice(0, 60)}`);
				}
				continue;
			}
			lastUntouched = null;

			if (!commandInFlight(ws)) {
				firstSeen.clear();
				noticed.clear();
				continue;
			}
			const toasts = await queue(() => keeper.notifications());
			const now = Date.now();
			for (const toast of toasts) {
				if (toast.buttons.length === 0) continue; // ボタンが無い通知は待たせない
				if (declineAll) {
					// 何もしない約束のとき。ただし放置したことは控える（命令は返らないままになる）
					if (noticed.has(toast.text)) continue;
					noticed.add(toast.text);
					screenLog.push({
						level: toast.level,
						modal: false,
						message: toast.text,
						buttons: toast.buttons,
						answered: null,
					});
					console.log(`ボタン付きの通知を放置しました: ${toast.text.split("\n")[0].slice(0, 60)}`);
					continue;
				}
				const seen = firstSeen.get(toast.text) ?? now;
				firstSeen.set(toast.text, seen);
				if (now - seen < 2000) continue; // すぐ消えるものを慌てて閉じない
				const head = toast.text.split("\n")[0].slice(0, 60);
				await queue(() => keeper.dismissNotificationByText(head));
				firstSeen.delete(toast.text);
				screenLog.push({
					level: toast.level,
					modal: false,
					message: toast.text,
					buttons: toast.buttons,
					answered: null,
					dismissed: true,
				});
				console.log(`止まっていた通知を閉じました: ${head}`);
			}
		} catch {
			// 画面が入れ替わる途中は掴み損ねる。次の周回で見直す
		}
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
