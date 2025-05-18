import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { syncCommand } from "./commands/sync/sync-command";
import { transCommand } from "./commands/trans/trans-command";
import { DefaultTranslationProvider } from "./commands/trans/translation-provider";
import { Configuration } from "./config/configuration";
import { FileExplorer } from "./utils/file-explorer";

export function activate(context: vscode.ExtensionContext) {
	// sync command
	const syncDisposable = vscode.commands.registerCommand(
		"mdait.sync",
		syncCommand,
	);

	// trans command
	const transDisposable = vscode.commands.registerCommand(
		"mdait.trans",
		transCommand,
	);

	console.log('"mdait" is now active.');
	context.subscriptions.push(transDisposable);
	context.subscriptions.push(syncDisposable);
}
