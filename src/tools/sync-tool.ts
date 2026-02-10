import * as vscode from "vscode";
import { syncCommand } from "../commands/sync/sync-command";
import { StatusManager } from "../core/status/status-manager";
import { Logger } from "../utils/logger";

const logger = Logger.getInstance();

/**
 * 入力パラメータ: 同期ツール
 */
type SyncInput = Record<string, never>; // 入力パラメータなし

/**
 * mdaitの同期ツール
 * GitHub Copilot Chatから翻訳マーカーの同期を実行するためのツール
 */
export class MdaitSyncTool implements vscode.LanguageModelTool<SyncInput> {
	async invoke(
		_options: vscode.LanguageModelToolInvocationOptions<SyncInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		try {
			logger.info("LanguageModelTool", "Sync tool invoked");

			// 同期コマンドを実行
			await syncCommand();

			// 同期後のステータスを取得
			const statusManager = StatusManager.getInstance();
			const tree = statusManager.getStatusItemTree();
			const progress = tree.aggregateProgress();
			const untranslatedUnits = progress.totalUnits - progress.translatedUnits;

			const resultText = vscode.l10n.t(
				"Synchronization completed.\n\nCurrent translation status:\n- Total units: {0}\n- Translated: {1}\n- Untranslated: {2}\n- Error: {3}",
				progress.totalUnits,
				progress.translatedUnits,
				untranslatedUnits,
				progress.errorUnits,
			);

			return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(resultText)]);
		} catch (error) {
			logger.error("LanguageModelTool", "Error in sync tool", { error });
			const errorMessage = vscode.l10n.t("Failed to synchronize: {0}", (error as Error).message);
			return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(errorMessage)]);
		}
	}

	async prepareInvocation(
		_options: vscode.LanguageModelToolInvocationPrepareOptions<SyncInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.PreparedToolInvocation> {
		// 同期はマーカーを書き換えるため確認が必要
		return {
			invocationMessage: vscode.l10n.t("Synchronizing translation markers..."),
			confirmationMessages: {
				title: vscode.l10n.t("Confirm Synchronization"),
				message: vscode.l10n.t(
					"This will update translation markers in your Markdown files. Do you want to proceed?",
				),
			},
		};
	}
}
