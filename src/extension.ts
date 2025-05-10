import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { transCommand } from "./commands/trans/trans-command";
import { DefaultTranslationProvider } from "./commands/trans/translation-provider";
import { Configuration } from "./config/configuration";
import { FileExplorer } from "./utils/file-explorer";

export function activate(context: vscode.ExtensionContext) {
	console.log('Congratulations, your extension "mdait" is now active!');

	// trans command
	const transDisposable = vscode.commands.registerCommand(
		"mdait.trans",
		transCommand,
	);

	context.subscriptions.push(transDisposable);
}
