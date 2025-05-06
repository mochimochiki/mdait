import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { translateCommand } from "./commands/translate/translate-command";
import { DefaultTranslationProvider } from "./commands/translate/translation-provider";
import { Configuration } from "./config/configuration";
import { FileExplorer } from "./utils/file-explorer";

export function activate(context: vscode.ExtensionContext) {
	console.log('Congratulations, your extension "mdtrans" is now active!');

	// translate command
	const translateDisposable = vscode.commands.registerCommand(
		"mdtrans.translate",
		translateCommand,
	);

	context.subscriptions.push(translateDisposable);
}
