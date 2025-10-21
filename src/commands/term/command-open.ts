import * as vscode from "vscode";
import { Configuration } from "../../config/configuration";

/**
 * openTerm command
 * 用語集ファイルを開く
 */
export async function openTermCommand(): Promise<void> {
	try {
		const config = Configuration.getInstance();
		const termFilePath = config.getTermsFilePath();

		// ファイルが存在するか確認
		try {
			await vscode.workspace.fs.stat(vscode.Uri.file(termFilePath));
		} catch {
			// ファイルが存在しない場合はメッセージを表示して終了
			vscode.window.showInformationMessage(vscode.l10n.t("Glossary file does not exist: {0}", termFilePath));
			return;
		}

		// ファイルを開く
		const document = await vscode.workspace.openTextDocument(termFilePath);
		await vscode.window.showTextDocument(document);
	} catch (error) {
		vscode.window.showErrorMessage(vscode.l10n.t("Failed to open glossary file: {0}", (error as Error).message));
		console.error("Failed to open term file:", error);
	}
}
