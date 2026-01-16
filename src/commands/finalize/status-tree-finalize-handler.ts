import * as path from "node:path";
import * as vscode from "vscode";
import type { StatusItem } from "../../core/status/status-item";
import { StatusItemType } from "../../core/status/status-item";
import { finalizeDirectoryCommand, finalizeFileCommand } from "./finalize-command";

/**
 * ステータスツリーからのfinalize操作を処理するハンドラ
 */
export class StatusTreeFinalizeHandler {
	/**
	 * ディレクトリのfinalizeコマンドを実行
	 */
	async handleFinalizeDirectory(item: StatusItem): Promise<void> {
		if (item.type !== StatusItemType.Directory) {
			vscode.window.showErrorMessage(vscode.l10n.t("Invalid item type for directory finalize"));
			return;
		}

		// directoryPath is already the full path
		await finalizeDirectoryCommand(item.directoryPath);
	}

	/**
	 * ファイルのfinalizeコマンドを実行
	 */
	async handleFinalizeFile(item: StatusItem): Promise<void> {
		if (item.type !== StatusItemType.File) {
			vscode.window.showErrorMessage(vscode.l10n.t("Invalid item type for file finalize"));
			return;
		}

		// filePath is already the full path
		await finalizeFileCommand(item.filePath);
	}
}
