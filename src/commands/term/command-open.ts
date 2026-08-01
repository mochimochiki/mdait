import * as vscode from "vscode";
import { StatusItemType } from "../../core/status/status-item";
import { Configuration } from "../../infra/config/configuration";

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
			// まだ作られていないのは正常な状態。作り方を案内する（エラーにしない）
			const detectAction = vscode.l10n.t("Detect Terms");
			const selection = await vscode.window.showInformationMessage(
				vscode.l10n.t("No glossary yet. Run term detection on a source file to collect terms into the glossary."),
				detectAction,
			);
			if (selection === detectAction) {
				await runTermDetectForActiveEditor();
			}
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

/**
 * アクティブエディタのファイルに対して用語検出を起動する。
 * 対象ファイルの妥当性チェック（ソースファイルか等）は mdait.term.detect.file 側が行う。
 */
async function runTermDetectForActiveEditor(): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		vscode.window.showInformationMessage(
			vscode.l10n.t("Open a source Markdown file, then run term detection from the mdait view."),
		);
		return;
	}
	await vscode.commands.executeCommand("mdait.term.detect.file", {
		type: StatusItemType.File,
		filePath: editor.document.uri.fsPath,
	});
}
