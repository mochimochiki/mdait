import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { chatCommand } from "./commands/chat/chat-command";
import { syncCommand } from "./commands/sync/sync-command";
import { transCommand } from "./commands/trans/trans-command";
import { DefaultTranslator } from "./commands/trans/translator";
import { Configuration } from "./config/configuration";
import { StatusTreeProvider } from "./ui/status/status-tree-provider";
import { FileExplorer } from "./utils/file-explorer";

export function activate(context: vscode.ExtensionContext) {
	// sync command
	const syncDisposable = vscode.commands.registerCommand("mdait.sync", syncCommand);

	// trans command
	const transDisposable = vscode.commands.registerCommand("mdait.trans", transCommand);

	// chat command
	const chatDisposable = vscode.commands.registerCommand("mdait.chat", chatCommand);

	// ステータスツリービューを作成
	const statusTreeProvider = new StatusTreeProvider();
	const treeView = vscode.window.createTreeView("mdait.status", {
		treeDataProvider: statusTreeProvider,
		showCollapseAll: false,
	});

	// status.refresh command
	const refreshStatusDisposable = vscode.commands.registerCommand("mdait.status.refresh", () => {
		statusTreeProvider.refresh();
	});

	// 初回データ読み込み
	statusTreeProvider.refresh();

	context.subscriptions.push(
		syncDisposable,
		transDisposable,
		chatDisposable,
		treeView,
		refreshStatusDisposable,
	);
}
