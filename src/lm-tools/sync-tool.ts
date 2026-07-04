import * as vscode from "vscode";
import { syncCommand } from "../commands/sync/sync-command";
import { StatusManager } from "../core/status/status-manager";
import { Logger } from "../infra/logging/logger";
import { ToolErrorCode, createErrorEnvelope, createOkEnvelope } from "./envelope";
import { buildNextActions } from "./next-actions";
import { buildStatusData, type StatusData } from "./status-data";
import { toToolResult } from "./tool-result";

const logger = Logger.getInstance();

/**
 * 入力パラメータ: 同期ツール
 */
type SyncInput = Record<string, never>; // 入力パラメータなし

/** mdait_sync の data 形式 */
interface SyncData {
	files: {
		total: number;
		succeeded: number;
		failed: number;
	};
	units: {
		added: number;
		modified: number;
		deleted: number;
		unchanged: number;
		revisionsNeeded: number;
	};
	durationMs: number;
	/** 同期後の全体ステータス */
	status: StatusData;
}

/**
 * mdaitの同期ツール
 * GitHub Copilot Chatから翻訳マーカーの同期を実行するためのツール
 * 出力は共通エンベロープのJSON文字列（docs/design/agent-orchestration.md 参照）
 */
export class MdaitSyncTool implements vscode.LanguageModelTool<SyncInput> {
	async invoke(
		_options: vscode.LanguageModelToolInvocationOptions<SyncInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		try {
			logger.info("LanguageModelTool", "Sync tool invoked");

			// 同期コマンドを実行
			const syncResult = await syncCommand();
			if (!syncResult) {
				const message = vscode.l10n.t("Synchronization did not run. Check the mdait configuration.");
				return toToolResult(
					createErrorEnvelope(message, ToolErrorCode.InternalError, message, [
						"Check .mdait/mdait.json configuration (transPairs, primaryLang) and retry mdait_sync.",
					]),
				);
			}

			// 同期後のステータスを取得
			const statusManager = StatusManager.getInstance();
			const tree = statusManager.getStatusItemTree();
			const status = buildStatusData(tree.getFilesAll(), false);

			const data: SyncData = {
				files: {
					total: syncResult.totalFileCount,
					succeeded: syncResult.successCount,
					failed: syncResult.errorCount,
				},
				units: {
					added: syncResult.totalAdded,
					modified: syncResult.totalModified,
					deleted: syncResult.totalDeleted,
					unchanged: syncResult.totalUnchanged,
					revisionsNeeded: syncResult.revisionsNeeded,
				},
				durationMs: syncResult.durationMs,
				status,
			};

			const summary = vscode.l10n.t(
				"Synchronization completed: {0} file(s) processed, {1} failed. Units: {2} added, {3} modified, {4} deleted, {5} need revision.",
				syncResult.totalFileCount,
				syncResult.errorCount,
				syncResult.totalAdded,
				syncResult.totalModified,
				syncResult.totalDeleted,
				syncResult.revisionsNeeded,
			);

			const nextActions = buildNextActions(status.needs, status.errorUnits);
			return toToolResult(createOkEnvelope(summary, data, nextActions));
		} catch (error) {
			logger.error("LanguageModelTool", "Error in sync tool", { error });
			const errorMessage = vscode.l10n.t("Failed to synchronize: {0}", (error as Error).message);
			return toToolResult(
				createErrorEnvelope(errorMessage, ToolErrorCode.InternalError, (error as Error).message),
			);
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
