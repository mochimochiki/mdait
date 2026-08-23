/**
 * vscode モジュールのモック登録
 *
 * mocha の --require で読み込まれ、`require("vscode")` をインターセプトする。
 * テスト側で `global.__vscodeMockWorkspaceRoot` を設定することで
 * vscode.workspace.workspaceFolders の返却値を制御できる。
 * 同様に `global.__vscodeMockLanguage` で vscode.env.language（表示言語）を制御できる。
 *
 * @example
 * // テストファイル内
 * setup(() => {
 *   global.__vscodeMockWorkspaceRoot = tempDir;
 *   global.__vscodeMockLanguage = "ja";
 * });
 */
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");

// デフォルトのワークスペースルート（テスト側で上書き可能）
global.__vscodeMockWorkspaceRoot = "/mock-workspace";
// デフォルトの表示言語（テスト側で上書き可能。undefined を代入すると en に戻る）
global.__vscodeMockLanguage = undefined;
// showXxxMessage の記録先（テスト側で配列を代入したときだけ控える）と、押されたボタンの差し替え
global.__vscodeMockShownMessages = undefined;
global.__vscodeMockMessageChoice = undefined;
// executeCommand の記録先（配列を代入したときだけ控える）と、コマンドの実装差し替え。
// __vscodeMockCommandHandlers にオブジェクトを代入すると、そこに無い ID の実行は
// 実 VS Code と同じく "command 'xxx' not found" で失敗する
global.__vscodeMockExecutedCommands = undefined;
global.__vscodeMockCommandHandlers = undefined;
// vscode.window.activeTextEditor の差し替え
global.__vscodeMockActiveTextEditor = undefined;

/** showXxxMessage の呼び出しを控える（テストが「何本出たか」を見られるようにする） */
function recordMessage(level, message, items) {
	const flat = items.flat();
	const shown = global.__vscodeMockShownMessages;
	if (Array.isArray(shown)) {
		shown.push({ level, message, items: flat });
	}
	const choice = global.__vscodeMockMessageChoice;
	// 関数を代入すると、通知ごとに押すボタンを選び分けられる（続けて2枚出る確認など）
	return typeof choice === "function" ? choice({ level, message, items: flat }) : choice;
}

const vscodeMock = {
	workspace: {
		get workspaceFolders() {
			const root = global.__vscodeMockWorkspaceRoot;
			if (!root) return undefined;
			return [{ uri: { fsPath: root }, name: "mock-workspace", index: 0 }];
		},
		// エディタの未保存ドキュメント一覧（flushDirtyDocument 用。テストでは常に空）
		textDocuments: [],
		// CoreProc（ファイルの read-modify-write）をテスト可能にするため実ファイルI/Oに委譲する
		fs: {
			writeFile: async (uri, content) => {
				const target = uri.fsPath ?? String(uri);
				fs.mkdirSync(path.dirname(target), { recursive: true });
				fs.writeFileSync(target, Buffer.from(content));
			},
			readFile: async (uri) => {
				const target = uri.fsPath ?? String(uri);
				return new Uint8Array(fs.readFileSync(target));
			},
			// 実 VS Code と同じく、存在しないパスでは例外になる
			stat: async (uri) => {
				const target = uri.fsPath ?? String(uri);
				const s = fs.statSync(target);
				return { type: s.isDirectory() ? 2 : 1, ctime: s.ctimeMs, mtime: s.mtimeMs, size: s.size };
			},
		},
		getConfiguration: () => ({
			get: () => undefined,
			has: () => false,
			inspect: () => undefined,
			update: async () => {},
		}),
		// 実ファイルを読む最小の TextDocument（外部マーカー等の parse 経路テスト用）
		openTextDocument: async (uriOrPath) => {
			const target =
				typeof uriOrPath === "string" ? uriOrPath : (uriOrPath.fsPath ?? String(uriOrPath));
			const text = fs.readFileSync(target, "utf-8");
			const lines = text.split(/\r?\n/);
			return {
				uri: { fsPath: target, scheme: "file", path: target.replace(/\\/g, "/") },
				fileName: target,
				getText: () => text,
				lineCount: lines.length,
				lineAt: (i) => ({ text: lines[i] ?? "" }),
			};
		},
	},
	// 表示言語（テスト側で global.__vscodeMockLanguage を設定して上書きできる）
	env: {
		get language() {
			return global.__vscodeMockLanguage ?? "en";
		},
	},
	l10n: {
		t: (message, ...args) => {
			if (typeof message !== "string") return String(message);
			return args.reduce(
				(s, a, i) => s.replace(`{${i}}`, String(a)),
				message,
			);
		},
	},
	commands: {
		executeCommand: async (command, ...args) => {
			const executed = global.__vscodeMockExecutedCommands;
			if (Array.isArray(executed)) {
				executed.push({ command, args });
			}
			const handlers = global.__vscodeMockCommandHandlers;
			if (!handlers) {
				return undefined;
			}
			const handler = handlers[command];
			if (!handler) {
				// 実 VS Code と同じ失敗の仕方（未登録 ID を踏んだことをテストが捕まえられる）
				throw new Error(`command '${command}' not found`);
			}
			return handler(...args);
		},
		registerCommand: () => ({ dispose: () => {} }),
	},
	Uri: {
		file: (p) => ({
			fsPath: p,
			scheme: "file",
			path: p.replace(/\\/g, "/"),
		}),
		parse: (s) => ({ fsPath: s, scheme: "file", path: s }),
	},
	window: {
		// 出したトーストをテストから見られるよう控える（モック限定の便宜）。
		// テスト側で global.__vscodeMockShownMessages = [] と初期化して使う。
		// 返す選択肢は global.__vscodeMockMessageChoice で差し替えられる
		showInformationMessage: async (message, ...items) => recordMessage("info", message, items),
		showWarningMessage: async (message, ...items) => recordMessage("warning", message, items),
		showErrorMessage: async (message, ...items) => recordMessage("error", message, items),
		get activeTextEditor() {
			return global.__vscodeMockActiveTextEditor;
		},
		showTextDocument: async (document) => ({ document }),
		createOutputChannel: () => ({
			appendLine: () => {},
			append: () => {},
			clear: () => {},
			show: () => {},
			hide: () => {},
			dispose: () => {},
		}),
	},
	// ファイル操作を伴う編集（onWillRenameFiles の waitUntil に返す WorkspaceEdit）。
	// 実 VS Code はリネームの一覧を読み出す API を公開していないため、
	// テストから何が載ったかを見られるよう renamedFiles に控える（モック限定の便宜）。
	WorkspaceEdit: class {
		constructor() {
			this.renamedFiles = [];
		}
		renameFile(oldUri, newUri, options) {
			this.renamedFiles.push({ oldUri, newUri, options });
		}
	},
	// LanguageModelTool 系（LM Tool の invoke / prepareInvocation を単体で叩くための最小実装）。
	// 実 VS Code は結果を LanguageModelToolResult に包むので、テスト側が中身を読めるよう
	// parts をそのまま保持する（lm-tools/tool-result.ts の toToolResult が使う）。
	LanguageModelTextPart: class {
		constructor(value) {
			this.value = value;
		}
	},
	LanguageModelToolResult: class {
		constructor(parts) {
			this.content = parts;
		}
	},
	// TreeView 系（StatusTreeProvider.getTreeItem の単体テスト用の最小実装）
	TreeItem: class {
		constructor(label, collapsibleState) {
			this.label = label;
			this.collapsibleState = collapsibleState;
		}
	},
	TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
	ThemeIcon: class {
		constructor(id, color) {
			this.id = id;
			this.color = color;
		}
	},
	ThemeColor: class {
		constructor(id) {
			this.id = id;
		}
	},
	EventEmitter: class {
		constructor() {
			this._listeners = [];
			this.event = (listener) => {
				this._listeners.push(listener);
				return {
					dispose: () => {
						const idx = this._listeners.indexOf(listener);
						if (idx >= 0) this._listeners.splice(idx, 1);
					},
				};
			};
		}
		fire(data) {
			for (const listener of this._listeners) {
				listener(data);
			}
		}
		dispose() {
			this._listeners = [];
		}
	},
	CancellationTokenSource: class {
		constructor() {
			this.token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) };
		}
		cancel() { this.token.isCancellationRequested = true; }
		dispose() {}
	},
	// 実VS Codeと同じく name/message が "Canceled" のエラー（キャンセル判定のテスト用）
	CancellationError: class extends Error {
		constructor() {
			super("Canceled");
			this.name = "Canceled";
		}
	},
};

// Module._resolveFilename をフックして "vscode" を自身のパスに解決
const originalResolveFilename = Module._resolveFilename;
const mockModulePath = path.resolve(__filename);

Module._resolveFilename = function (request, parent, isMain, options) {
	if (request === "vscode") {
		return mockModulePath;
	}
	return originalResolveFilename.call(this, request, parent, isMain, options);
};

// require.cache にモックを登録
require.cache[mockModulePath] = {
	id: mockModulePath,
	filename: mockModulePath,
	loaded: true,
	exports: vscodeMock,
	children: [],
	paths: [],
	path: path.dirname(mockModulePath),
	require,
};

module.exports = vscodeMock;
