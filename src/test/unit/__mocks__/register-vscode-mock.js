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
		},
		getConfiguration: () => ({
			get: () => undefined,
			has: () => false,
			inspect: () => undefined,
			update: async () => {},
		}),
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
	Uri: {
		file: (p) => ({
			fsPath: p,
			scheme: "file",
			path: p.replace(/\\/g, "/"),
		}),
		parse: (s) => ({ fsPath: s, scheme: "file", path: s }),
	},
	window: {
		showInformationMessage: async () => undefined,
		showWarningMessage: async () => undefined,
		showErrorMessage: async () => undefined,
		createOutputChannel: () => ({
			appendLine: () => {},
			append: () => {},
			clear: () => {},
			show: () => {},
			hide: () => {},
			dispose: () => {},
		}),
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
