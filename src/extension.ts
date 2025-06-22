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
	const syncStatusDisposable = vscode.commands.registerCommand("mdait.status.sync", async () => {
		try {
			await vscode.commands.executeCommand("setContext", "mdaitSyncProcessing", true);
			await syncCommand();
			statusTreeProvider.refresh();
		} catch (error) {
			vscode.window.showErrorMessage(
				vscode.l10n.t("Failed to sync and refresh: {0}", (error as Error).message),
			);
		} finally {
			await vscode.commands.executeCommand("setContext", "mdaitSyncProcessing", false);
		}
	});

	// jumpToUnit command
	const jumpToUnitDisposable = vscode.commands.registerCommand(
		"mdait.jumpToUnit",
		async (filePath: string, line: number) => {
			try {
				const document = await vscode.workspace.openTextDocument(filePath);
				const editor = await vscode.window.showTextDocument(document);

				// 指定行にジャンプ（0ベースから1ベースに変換）
				const position = new vscode.Position(line, 0);
				editor.selection = new vscode.Selection(position, position);
				editor.revealRange(
					new vscode.Range(position, position),
					vscode.TextEditorRevealType.InCenter,
				);
			} catch (error) {
				vscode.window.showErrorMessage(
					vscode.l10n.t("Failed to jump to unit: {0}", (error as Error).message),
				);
			}
		},
	);

	// 初回データ読み込み
	statusTreeProvider.refresh();
	context.subscriptions.push(
		syncDisposable,
		transDisposable,
		chatDisposable,
		treeView,
		syncStatusDisposable,
		jumpToUnitDisposable,
	);
}
