import * as vscode from "vscode";
import { Configuration } from "../../config/configuration";

/**
 * openTm command
 * Open TM file
 */
export async function openTmCommand(): Promise<void> {
	try {
		const config = Configuration.getInstance();
		const tmFilePath = config.getTmFilePath();

		// Check if file exists
		try {
			await vscode.workspace.fs.stat(vscode.Uri.file(tmFilePath));
		} catch {
			// Show message if file does not exist
			vscode.window.showInformationMessage(vscode.l10n.t("TM file does not exist: {0}", tmFilePath));
			return;
		}

		// Open file
		const document = await vscode.workspace.openTextDocument(tmFilePath);
		await vscode.window.showTextDocument(document);
	} catch (error) {
		vscode.window.showErrorMessage(vscode.l10n.t("Failed to open TM file: {0}", (error as Error).message));
		console.error("Failed to open TM file:", error);
	}
}
