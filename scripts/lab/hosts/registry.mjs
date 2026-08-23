/*
 * コマンド名（mdait.*）と、その実体の対応表。
 *
 * Extension Host を立てない headless ホストは vscode.commands の仕組みを持たないので、
 * この表を引いて out/ の関数を直に呼ぶ。
 * 引数の作り替え（文字列 → Uri / StatusItem）は src/infra/debug/debug-command-handler.ts と
 * 同じ表を使う。実 Extension Host でも headless でも、渡すものが同じになるようにするため。
 *
 * 表には「どのホストで使えるか」を書く。UI の答えが要るもの、Extension Host が要るものは
 * headless では動かせないので、その旨を理由つきで持たせて `lab run` が実行前に知らせる。
 */
import fs from "node:fs";


// --- 引数の作り替え（debug-command-handler.ts と同じ表） -------------------

/** 1つ目の文字列を Uri にする */
const URI_FILE_COMMANDS = new Set(["mdait.trans", "mdait.translate.frontmatter"]);
/**
 * 1つ目の文字列を「ファイルの StatusItem」にする。
 *
 * `mdait.term.detect.file` と `mdait.term.expand.file` は debug-command-handler.ts の表に
 * 載っているが、実際にはどこにも登録されていない（=存在しないコマンド名）。表の形を合わせる
 * ためだけに残してあり、下の COMMANDS には載せていない。
 */
const FILE_ITEM_COMMANDS = new Set([
	"mdait.translate.file",
	"mdait.tm.commit.file",
	"mdait.term.detect.file",
	"mdait.term.expand.file",
	"mdait.aiReview.file",
]);
/** 1つ目の文字列を「フォルダの StatusItem」にする（上と同じ理由で term.* の2つは飾り） */
const DIRECTORY_ITEM_COMMANDS = new Set([
	"mdait.translate.directory",
	"mdait.term.detect.directory",
	"mdait.term.expand.directory",
	"mdait.tm.commit.directory",
	"mdait.aiReview.directory",
]);

/** ファイルの StatusItem を組む（StatusItemType.File の文字列表現は "file"） */
export function fileStatusItem(filePath) {
	return { type: "file", filePath, fileName: filePath.split(/[\\/]/).pop() ?? "" };
}

/** フォルダの StatusItem を組む */
export function directoryStatusItem(directoryPath) {
	return { type: "directory", directoryPath, label: directoryPath.split(/[\\/]/).pop() ?? "" };
}

/**
 * パスを見て、ファイルかフォルダかに合った StatusItem を組む。
 * `mdait.term.expand` のように「file 版 / directory 版」に分かれていないコマンドで使う。
 */
export function statusItemForPath(target) {
	let isDirectory = false;
	try {
		isDirectory = fs.statSync(target).isDirectory();
	} catch {
		// 無いものはファイル扱いにする（存在しない旨はコマンド側が言う）
	}
	return isDirectory ? directoryStatusItem(target) : fileStatusItem(target);
}

/**
 * コマンド名に応じて引数を作り替える。文字列のまま渡してよいものはそのまま返す。
 * @param {string} command
 * @param {unknown[]} args
 * @param {{Uri: {file: (p: string) => unknown}}} vscode
 */
export function transformArgs(command, args, vscode) {
	if (args.length === 0 || typeof args[0] !== "string") return args;
	if (URI_FILE_COMMANDS.has(command)) return [vscode.Uri.file(args[0]), ...args.slice(1)];
	if (FILE_ITEM_COMMANDS.has(command)) return [fileStatusItem(args[0]), ...args.slice(1)];
	if (DIRECTORY_ITEM_COMMANDS.has(command)) return [directoryStatusItem(args[0]), ...args.slice(1)];
	const entry = COMMANDS[command];
	// パスの姿（ファイルかフォルダか）を見て決めるもの
	if (entry?.args === "auto-item") return [statusItemForPath(args[0]), ...args.slice(1)];
	return args;
}

// --- どのホストで使えるか -------------------------------------------------

/** すべてのホストで使える */
const ALL = ["headless", "code-server", "desktop"];
/** 実 Extension Host が要る（画面・エディタ・ダイアログの答えが要る） */
const HOST_ONLY = ["code-server", "desktop"];
/** headless の身代わり実装でしか動かない（vscode.commands を通らない呼び方をしている） */
const HEADLESS_ONLY = ["headless"];

/**
 * @typedef {object} CommandEntry
 * @property {string} module out/ の中の場所（headless が読み込む）
 * @property {string} [export] 呼ぶ関数の名前（既定はコマンド名から決まらないので必須）
 * @property {"none"|"raw"|"uri"|"file-item"|"dir-item"|"auto-item"} args 引数の作り替え方
 * @property {string[]} hosts 使えるホスト
 * @property {string} note 何をするか・注意
 * @property {string} [adapter] headless 側の身代わり実装の名前（module の代わり）
 * @property {boolean} [asksUser] 途中でユーザーの答えを求める（headless では「答えなし」になる）
 */

/** @type {Record<string, CommandEntry>} */
export const COMMANDS = {
	// --- 同期・翻訳 ---
	"mdait.sync": {
		module: "out/commands/sync/sync-command.js",
		export: "syncCommand",
		args: "raw",
		hosts: ALL,
		note: "原文と訳文の対応づけを取り直す。AI は使わない",
	},
	"mdait.trans": {
		module: "out/commands/trans/trans-command.js",
		export: "transCommand",
		args: "uri",
		hosts: ALL,
		note: "1ファイルを翻訳する。引数は**訳文の側**のファイルのパス（原文を渡すと no-trans-pair で何もしない）",
	},
	"mdait.translate.file": {
		module: "out/commands/trans/status-tree-translation-handler.js",
		export: "StatusTreeTranslationHandler",
		method: "translateFile",
		args: "file-item",
		hosts: ALL,
		note: "ツリーの「ファイルを翻訳」。引数は訳文の側のファイルのパス",
	},
	"mdait.translate.directory": {
		module: "out/commands/trans/status-tree-translation-handler.js",
		export: "StatusTreeTranslationHandler",
		method: "translateDirectory",
		args: "dir-item",
		hosts: ALL,
		note: "ツリーの「フォルダを翻訳」。引数は訳文の側のフォルダのパス",
	},
	"mdait.trans.pendingTargets": {
		module: "out/commands/trans/status-tree-translation-handler.js",
		export: "StatusTreeTranslationHandler",
		method: "translatePendingTargets",
		args: "none",
		hosts: ALL,
		note: "翻訳待ちをまとめて翻訳する（sync 完了通知の「今すぐ翻訳」と同じ）",
	},
	"mdait.translate.frontmatter": {
		module: "out/commands/trans/trans-command.js",
		export: "translateFrontmatterCommand",
		args: "uri",
		hosts: ALL,
		note: "frontmatter だけを翻訳する。引数は訳文の側のファイルのパス",
	},

	// --- マーカーの置き場の切り替え ---
	"mdait.markers.externalize": {
		module: "out/commands/markers/markers-migration.js",
		export: "externalizeMarkersCommand",
		args: "none",
		hosts: ALL,
		note: "本文のマーカーを外部（.mdait/unit-state）へ移す",
	},
	"mdait.markers.embed": {
		module: "out/commands/markers/markers-migration.js",
		export: "embedMarkersCommand",
		args: "none",
		hosts: ALL,
		note: "外部のマーカーを本文へ戻す",
	},

	// --- 用語集 ---
	"mdait.term.detect": {
		adapter: "termDetect",
		args: "raw",
		hosts: HEADLESS_ONLY,
		note:
			"用語を拾って用語集へ足す。登録されている本体は引数に (units, transPair) を取り、パスを受けないため" +
			" IPC からは叩けない。headless では lab 側の身代わり（detectTerm_CoreProc を直に呼ぶ）で動かしている。" +
			"実 Extension Host では vscode.commands を通るのでこの身代わりが効かない",
	},
	"mdait.term.expand": {
		module: "out/commands/term/command-expand.js",
		export: "expandTermCommand",
		args: "auto-item",
		hosts: ALL,
		note: "用語集の訳語が空の行を埋める。引数はファイルでもフォルダでもよい（渡した姿で判断する）",
	},
	"mdait.term.update": {
		module: "out/commands/term/command-update.js",
		export: "updateGlossaryCommand",
		args: "auto-item",
		hosts: ALL,
		note: "用語集の更新（検出→展開をまとめて行う）。引数はファイルでもフォルダでもよい",
	},

	// --- 翻訳メモリ ---
	"mdait.tm.commit.file": {
		module: "out/commands/tm/command-commit.js",
		export: "tmCommitFileCommand",
		args: "file-item",
		hosts: ALL,
		note: "1ファイルの対訳を翻訳メモリへ登録する",
	},
	"mdait.tm.commit.directory": {
		module: "out/commands/tm/command-commit.js",
		export: "tmCommitDirectoryCommand",
		args: "dir-item",
		hosts: ALL,
		note: "フォルダ配下の対訳を翻訳メモリへ登録する",
	},
	"mdait.tm.optimize": {
		module: "out/commands/tm/command-optimize.js",
		export: "tmOptimizeCommand",
		args: "none",
		hosts: ALL,
		note: "翻訳メモリを整理する",
	},

	// --- AI レビュー・取り込み ---
	"mdait.aiReview.file": {
		module: "out/commands/ai-review/review-command.js",
		export: "aiReviewFileCommand",
		args: "file-item",
		hosts: ALL,
		note: "1ファイルの訳を AI に見てもらう",
	},
	"mdait.aiReview.directory": {
		module: "out/commands/ai-review/review-command.js",
		export: "aiReviewDirectoryCommand",
		args: "dir-item",
		hosts: ALL,
		note: "フォルダ配下の訳を AI に見てもらう",
	},
	"mdait.adopt.run": {
		module: "out/commands/adopt/adopt-command.js",
		export: "adoptCommand",
		args: "none",
		hosts: ALL,
		asksUser: true,
		note: "既にある訳を取り込む案内。最初に「どの段をやるか」を聞くので、答えられない headless では何もせず戻る",
	},

	// --- 裁定（ユニット単位の始末） ---
	"mdait.unit.markReviewed": {
		module: "out/commands/markers/status-tree-need-handler.js",
		export: "StatusTreeNeedHandler",
		method: "markReviewed",
		args: "raw",
		hosts: ALL,
		note: "「見た」と印を付けて need を外す。引数はユニットの StatusItem",
	},
	"mdait.unit.keep": {
		module: "out/commands/markers/status-tree-need-handler.js",
		export: "StatusTreeNeedHandler",
		method: "keepUnit",
		args: "raw",
		hosts: ALL,
		note: "消える予定だった章を残す（独立させる）。引数はユニットの StatusItem",
	},
	"mdait.unit.delete": {
		module: "out/commands/markers/status-tree-need-handler.js",
		export: "StatusTreeNeedHandler",
		method: "deleteUnit",
		args: "raw",
		hosts: ALL,
		asksUser: true,
		note: "章を消す。確認を出す",
	},
	"mdait.unit.markIsolated": {
		module: "out/commands/markers/status-tree-need-handler.js",
		export: "StatusTreeNeedHandler",
		method: "markIsolated",
		args: "raw",
		hosts: ALL,
		note: "この章は原文と対応しない、と宣言する",
	},
	"mdait.unit.unisolate": {
		module: "out/commands/markers/status-tree-need-handler.js",
		export: "StatusTreeNeedHandler",
		method: "unisolate",
		args: "raw",
		hosts: ALL,
		note: "独立の宣言を取り消す",
	},
	"mdait.file.keepVerifyDeletion": {
		module: "out/commands/markers/status-tree-need-handler.js",
		export: "StatusTreeNeedHandler",
		method: "keepAllInFile",
		args: "file-item",
		hosts: ALL,
		note: "そのファイルの「確認待ち」をまとめて残す",
	},
	"mdait.file.deleteVerifyDeletion": {
		module: "out/commands/markers/status-tree-need-handler.js",
		export: "StatusTreeNeedHandler",
		method: "deleteAllInFile",
		args: "file-item",
		hosts: ALL,
		asksUser: true,
		note: "そのファイルの「確認待ち」をまとめて消す。確認を出す",
	},
	"mdait.file.discardOrphan": {
		module: "out/commands/markers/discard-orphan.js",
		export: "discardOrphanTargetCommand",
		args: "file-item",
		hosts: ALL,
		asksUser: true,
		note: "原文と結びついていない訳文をごみ箱へ送る。確認を出す",
	},
	"mdait.needsAttention.next": {
		module: "out/commands/markers/needs-attention-next.js",
		export: "needsAttentionNextCommand",
		args: "raw",
		hosts: HOST_ONLY,
		note: "要対応の次の場所へ飛ぶ。エディタを開いて動かすので画面が要る",
	},

	// --- 設定・診断 ---
	"mdait.setup.createConfig": {
		module: "out/commands/setup/setup-command.js",
		export: "createConfigCommand",
		args: "none",
		hosts: ALL,
		note: "mdait.json を雛形から作る。拡張のフォルダ（assets/mdait.template.json）を見に行くので、headless では偽の context を渡している",
	},
	"mdait.setup.diagnose": {
		module: "out/commands/doctor/doctor-command.js",
		export: "diagnoseSetupCommand",
		args: "none",
		hosts: ALL,
		note: "設定の具合を調べてレポートに書く",
	},
};

/** headless では動かせないもの（理由つき）。表に無いコマンド名もここで扱う */
export const UI_ONLY_NOTE =
	"画面（ツリー・エディタ・ダイアログ）が要るため headless では動かせません。code-server ホストを使ってください";

/** 表を引く */
export function lookup(command) {
	return COMMANDS[command];
}

/** そのホストで使えるか */
export function isAvailableOn(command, host) {
	const entry = COMMANDS[command];
	if (!entry) return false;
	return entry.hosts.includes(host);
}

/** 表を並べる（--help や `lab run` の案内に使う） */
export function listCommands() {
	return Object.entries(COMMANDS).map(([id, entry]) => ({ id, ...entry }));
}
