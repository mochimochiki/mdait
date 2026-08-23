"use strict";
/*
 * 探索的テスト（Extension Host 非依存）用の vscode シム。
 *
 * repo の register-vscode-mock.js を読み込んで require("vscode") をモックへ解決し、
 * commands 層が使う vscode API を実FS委譲で増補する（withProgress / commands / findFiles など）。
 * これにより out/ のコンパイル済みコマンド（syncCommand / transCommand ...）を Node から直接駆動できる。
 *
 * 位置付け: docs/design/test.md の「③探索的テスト」の一種。VS Code をヘッドレス起動できない
 * 環境（クラウド等）でも、commands 層の機構を実ファイルに対して決定的に検証するための土台。
 */
const fs = require("node:fs");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..", "..");

// どのフォルダを「ワークスペース」として扱うかは呼び出し側が決められる。
// 優先順は 環境変数 MDAIT_LAB_WS → 事前に立てた global.__mdaitLabWorkspaceRoot → 従来のリポジトリ内テスト用フォルダ。
// （lab のヘッドレスホストは /tmp 側の使い捨てワークスペースを渡す。旧 run-sweep / probe は指定しないので従来どおり）
const WS = path.resolve(
	process.env.MDAIT_LAB_WS || global.__mdaitLabWorkspaceRoot || path.join(REPO, "src/test/unit/workspace"),
);

// モックは読込時に __vscodeMockWorkspaceRoot を既定値で上書きするため、後で再設定する
const vscode = require(path.join(REPO, "src/test/unit/__mocks__/register-vscode-mock.js"));
global.__vscodeMockWorkspaceRoot = WS;

// 名前空間を確保
vscode.window = vscode.window || {};
vscode.workspace = vscode.workspace || {};
vscode.commands = vscode.commands || {};

// ProgressLocation / withProgress
vscode.ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 };
vscode.window.withProgress = async (_opts, task) => {
	const progress = { report: () => {} };
	const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) };
	return await task(progress, token);
};
vscode.window.showTextDocument = async () => ({});
vscode.window.activeTextEditor = undefined;
vscode.window.showInputBox = async () => undefined;

/*
 * 確認ダイアログへの答え方。
 *
 * 画面が無いので誰も答えられない。答えないと commands 層は「取り消された」と読んで
 * 無言で何もしない（実測: mdait.translate.directory は確認ダイアログで止まり、
 * ログ0行・返り値なしで終わっていた）。それでは何も確かめられないので、
 * ここでは**最初のボタン＝人が主たる操作を押したもの**として答える。
 *
 * ただし黙って押さない。押したことは必ず控えて lab の要約に出す。
 * 取り消し側を試したいときは MDAIT_LAB_DIALOG=no を設定する（どれにも答えない）。
 */
const answeredDialogs = [];
function answerDialog(level, message, items) {
	const flat = items.flat();
	const buttons = flat.filter((item) => typeof item === "string");
	const modal = flat.some((item) => item && typeof item === "object" && item.modal === true);
	// エラーの通知に付くボタンは「ログを開く」など別の操作なので押さない
	const declines = process.env.MDAIT_LAB_DIALOG === "no" || level === "error";
	const answered = declines ? undefined : buttons[0];
	answeredDialogs.push({ level, modal, message: String(message), buttons, answered: answered ?? null });
	return answered;
}
vscode.window.showInformationMessage = async (message, ...items) => answerDialog("info", message, items);
vscode.window.showWarningMessage = async (message, ...items) => answerDialog("warning", message, items);
vscode.window.showErrorMessage = async (message, ...items) => answerDialog("error", message, items);
/** 直前の命令で出たダイアログを読む（headless ホストが結果に載せる） */
vscode.__labDialogs = () => answeredDialogs.slice();
vscode.__labResetDialogs = () => {
	answeredDialogs.length = 0;
};

/*
 * 選択肢の一覧（QuickPick）にも同じ考え方で答える。
 *
 * 答えないと、選ばせてから始まる処理が丸ごと走らない。実測: `mdait.aiReview.file` は
 * 「未確認だけ / 全部」を選ばせる一覧で止まり、**ログ0行・返り値なしで done** になっていた。
 * 呼び手からは成功と区別が付かない。ここでは**先頭の選択肢**を選び、選んだことを控える。
 */
vscode.window.showQuickPick = async (items, options = {}) => {
	const list = Array.isArray(items) ? items : await items;
	const choice = process.env.MDAIT_LAB_DIALOG === "no" ? undefined : list?.[0];
	const label = (value) => (value && typeof value === "object" ? (value.label ?? JSON.stringify(value)) : String(value));
	answeredDialogs.push({
		level: "quickpick",
		modal: false,
		message: String(options.title ?? options.placeHolder ?? "選択肢の一覧"),
		buttons: (list ?? []).map(label),
		answered: choice === undefined ? null : label(choice),
	});
	return choice;
};
vscode.env = { openExternal: async () => true, language: "en" };

// RelativePattern
vscode.RelativePattern = class {
	constructor(base, pattern) {
		this.baseUri = { fsPath: typeof base === "string" ? base : base.fsPath };
		this.base = typeof base === "string" ? base : base.fsPath;
		this.pattern = pattern;
	}
};

// findFiles: RelativePattern.base 配下を再帰走査して Uri[] を返す（拡張子は呼び出し側でフィルタ）
function walk(dir, out) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		const full = path.join(dir, e.name);
		if (e.isDirectory()) {
			if (e.name === ".mdait" || e.name === ".git" || e.name === "node_modules") continue;
			walk(full, out);
		} else if (e.isFile()) {
			out.push(full);
		}
	}
}
// パターン（**/*.md / **/*.{md,txt} など）から拡張子集合を解釈する。実 VS Code の findFiles に近づけ、
// buildExtensionGlob が生成する拡張子グロブを尊重して不要ファイルの走査ノイズを避ける。
function extsFromPattern(pattern) {
	if (typeof pattern !== "string") return null;
	const brace = pattern.match(/\.\{([^}]+)\}\s*$/);
	if (brace) return brace[1].split(",").map((e) => `.${e.trim().toLowerCase()}`);
	const single = pattern.match(/\.([A-Za-z0-9]+)\s*$/);
	if (single) return [`.${single[1].toLowerCase()}`];
	return null; // 拡張子を特定できないパターンは従来どおり全件返す
}
vscode.workspace.findFiles = async (include) => {
	const base = include && (include.base || (include.baseUri && include.baseUri.fsPath));
	const roots = base ? [base] : global.__vscodeMockWorkspaceRoot ? [global.__vscodeMockWorkspaceRoot] : [];
	const files = [];
	for (const r of roots) walk(r, files);
	const exts = extsFromPattern(include && include.pattern);
	const filtered = exts ? files.filter((f) => exts.includes(path.extname(f).toLowerCase())) : files;
	return filtered.map((f) => vscode.Uri.file(f));
};

// openTextDocument: 実ファイルから最小の TextDocument 相当を返す
vscode.workspace.openTextDocument = async (uriOrPath) => {
	const fsPath = typeof uriOrPath === "string" ? uriOrPath : uriOrPath.fsPath;
	const text = fs.existsSync(fsPath) ? fs.readFileSync(fsPath, "utf8") : "";
	return {
		uri: vscode.Uri.file(fsPath),
		fileName: fsPath,
		isDirty: false,
		getText: () => text,
		save: async () => true,
		lineCount: text.split("\n").length,
	};
};
vscode.workspace.applyEdit = async () => true;
vscode.workspace.saveAll = async () => true;
vscode.workspace.asRelativePath = (p) => path.relative(global.__vscodeMockWorkspaceRoot, typeof p === "string" ? p : p.fsPath);

// commands: 内部呼び出しを登録済み実装へルーティング（未登録は no-op）
vscode._commandRegistry = new Map();
vscode.commands.registerCommand = (id, fn) => {
	vscode._commandRegistry.set(id, fn);
	return { dispose: () => vscode._commandRegistry.delete(id) };
};
vscode.commands.executeCommand = async (id, ...args) => {
	if (id === "setContext") return undefined;
	const fn = vscode._commandRegistry.get(id);
	return fn ? await fn(...args) : undefined;
};

// よく使う軽量シンボル
vscode.ThemeIcon = class {
	constructor(id) {
		this.id = id;
	}
};
vscode.ThemeColor = class {
	constructor(id) {
		this.id = id;
	}
};
vscode.MarkdownString = class {
	constructor(v) {
		this.value = v || "";
	}
	appendMarkdown(v) {
		this.value += v;
		return this;
	}
};
vscode.Range = class {
	constructor(s, e) {
		this.start = s;
		this.end = e;
	}
};
vscode.Position = class {
	constructor(l, c) {
		this.line = l;
		this.character = c;
	}
};
vscode.TreeItem = class {
	constructor(label) {
		this.label = label;
	}
};
vscode.TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
vscode.EndOfLine = { LF: 1, CRLF: 2 };
vscode.FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };

module.exports = { vscode, REPO, WS };
