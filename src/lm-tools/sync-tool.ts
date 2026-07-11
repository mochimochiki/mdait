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
interface SyncInput {
	/**
	 * 採用（adopt）モード: マーカーなし・本文ありの既存訳文を from 確立＋need:review で採用する。
	 * 既存対訳サイトの取り込み用の一度きりの操作。
	 */
	adopt?: boolean;
	/**
	 * AIアライン: adopt 時の位置ベース対応付けを AI で差分審査して誤ペアを修正する。
	 * adopt=true のときのみ有効。定常 sync では AI を動かさない（ADR-260705-01）。
	 */
	align?: boolean;
}

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
		/** adoptで採用（need:review付与）したユニット数 */
		adopted: number;
		/** 独立ユニット（from なし素 hash / need:isolate）として保持した孤立ターゲット数 */
		kept: number;
		/** マーカーなし孤立ターゲットに一次受け need:review を付与した数 */
		orphanReviewed: number;
		/** AIアラインが適用した修正提案数 */
		alignCorrections: number;
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
		options: vscode.LanguageModelToolInvocationOptions<SyncInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const adopt = options.input.adopt === true;
			// align は adopt 時のみ有効（adopt でなければ無視する）
			const align = adopt && options.input.align === true;
			logger.info("LanguageModelTool", "Sync tool invoked", { adopt, align });

			// 同期コマンドを実行
			const syncResult = await syncCommand({ adopt, align });
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
					adopted: syncResult.totalAdopted,
					kept: syncResult.totalKept,
					orphanReviewed: syncResult.totalOrphanReviewed,
					alignCorrections: syncResult.totalAlignCorrections,
				},
				durationMs: syncResult.durationMs,
				status,
			};

			const summary = adopt
				? vscode.l10n.t(
						"Synchronization (adopt) completed: {0} file(s) processed, {1} failed. Units: {2} adopted for review, {3} added, {4} deleted, {5} kept.",
						syncResult.totalFileCount,
						syncResult.errorCount,
						syncResult.totalAdopted,
						syncResult.totalAdded,
						syncResult.totalDeleted,
						syncResult.totalKept,
					)
				: vscode.l10n.t(
						"Synchronization completed: {0} file(s) processed, {1} failed. Units: {2} added, {3} modified, {4} deleted, {5} need revision.",
						syncResult.totalFileCount,
						syncResult.errorCount,
						syncResult.totalAdded,
						syncResult.totalModified,
						syncResult.totalDeleted,
						syncResult.revisionsNeeded,
					);

			const nextActions = buildNextActions(status.needs, status.errorUnits);
			if (syncResult.totalOrphanReviewed > 0) {
				nextActions.unshift(
					`${syncResult.totalOrphanReviewed} unmarked target-only unit(s) received need:review (no source counterpart found). For each, either remove the need flag to keep it as an independent unit, or delete the unit.`,
				);
			}
			if (align && syncResult.totalAlignCorrections > 0) {
				nextActions.unshift(
					`AI align re-paired ${syncResult.totalAlignCorrections} unit(s) whose position-based mapping was wrong. All adopted pairs remain need:review; run mdait_aiReview to verify the (re)aligned pairs — any residual mis-pairing surfaces as a mismatch.`,
				);
			}
			if (adopt && syncResult.totalAdopted > 0) {
				nextActions.unshift(
					`${syncResult.totalAdopted} existing translation unit(s) were adopted with need:review. Run mdait_aiReview to triage them with AI (auto-approves high-confidence matches, escalates suspected mis-pairings), or review and remove the need:review flags manually, then run mdait_sync again before committing them to the TM.`,
				);
			}
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
		options: vscode.LanguageModelToolInvocationPrepareOptions<SyncInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.PreparedToolInvocation> {
		// 同期はマーカーを書き換えるため確認が必要
		const adopt = options.input.adopt === true;
		const align = adopt && options.input.align === true;
		let message: string;
		if (align) {
			message = vscode.l10n.t(
				"This will adopt existing translations (marking them need:review) and use AI to review the position-based unit mapping and correct mis-pairings. It updates translation markers in your Markdown files. Committing your workspace to git beforehand is recommended. Do you want to proceed?",
			);
		} else if (adopt) {
			message = vscode.l10n.t(
				"This will adopt existing translations (marking them need:review) and update translation markers in your Markdown files. Committing your workspace to git beforehand is recommended. Do you want to proceed?",
			);
		} else {
			message = vscode.l10n.t(
				"This will update translation markers in your Markdown files. Do you want to proceed?",
			);
		}
		return {
			invocationMessage: vscode.l10n.t("Synchronizing translation markers..."),
			confirmationMessages: {
				title: vscode.l10n.t("Confirm Synchronization"),
				message,
			},
		};
	}
}
