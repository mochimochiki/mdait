import * as vscode from "vscode";
import { Configuration } from "../../infra/config/configuration";

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
			// まだ作られていないのは正常な状態。作り方を案内する（エラーにしない）
			vscode.window.showInformationMessage(
				vscode.l10n.t("No translation memory yet. It is built when you run TM Commit on translated files."),
			);
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
