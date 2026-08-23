import * as vscode from "vscode";
import { StatusItemType } from "../../core/status/status-item";
import { Configuration } from "../../infra/config/configuration";

/**
 * openTerm command
 * 用語集ファイルを開く
 */
export async function openTermCommand(): Promise<void> {
	// 用語集がまだ無いときの案内は「開けなかった」失敗とは別物。
	// 案内から起こす用語集の更新を下の try/catch の中で await すると、
	// 更新側の失敗が「用語集ファイルを開けませんでした」という無関係な文言で
	// 報告されてしまうため、押されたかどうかだけをここで受け取り、外で起こす
	let detectRequested = false;
	try {
		const config = Configuration.getInstance();
		const termFilePath = config.getTermsFilePath();

		// ファイルが存在するか確認
		let exists = true;
		try {
			await vscode.workspace.fs.stat(vscode.Uri.file(termFilePath));
		} catch {
			exists = false;
		}

		if (exists) {
			// ファイルを開く
			const document = await vscode.workspace.openTextDocument(termFilePath);
			await vscode.window.showTextDocument(document);
		} else {
			// まだ作られていないのは正常な状態。作り方を案内する（エラーにしない）
			const detectAction = vscode.l10n.t("Detect Terms");
			const selection = await vscode.window.showInformationMessage(
				vscode.l10n.t("No glossary yet. Run term detection on a source file to collect terms into the glossary."),
				detectAction,
			);
			detectRequested = selection === detectAction;
		}
	} catch (error) {
		vscode.window.showErrorMessage(vscode.l10n.t("Failed to open glossary file: {0}", (error as Error).message));
		console.error("Failed to open term file:", error);
		return;
	}

	if (detectRequested) {
		await runTermDetectForActiveEditor();
	}
}

/**
 * アクティブエディタのファイルに対して用語集の更新（検出＋展開）を起動する。
 * 対象ファイルの妥当性チェック（原文があるか等）は mdait.term.update 側が行い、
 * 対象が無ければ穏当な案内を出して終わる。
 */
async function runTermDetectForActiveEditor(): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		vscode.window.showInformationMessage(
			vscode.l10n.t("Open a source Markdown file, then run term detection from the mdait view."),
		);
		return;
	}
	await vscode.commands.executeCommand("mdait.term.update", {
		type: StatusItemType.File,
		filePath: editor.document.uri.fsPath,
	});
}
