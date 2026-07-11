import * as path from "node:path";
import * as vscode from "vscode";
import { executeAiSync } from "../commands/ai-sync/ai-sync-core";
import { type AiSyncOutcome, buildAiSyncNextActions } from "../commands/ai-sync/ai-sync-result";
import { type PairVerdict, aggregateReviewResults } from "../commands/ai-sync/review-result";
import { StatusManager } from "../core/status/status-manager";
import { Configuration } from "../infra/config/configuration";
import { Logger, formatError } from "../infra/logging/logger";
import { AIOnboarding } from "../infra/onboarding/ai-onboarding";
import { FileExplorer } from "../infra/workspace/file-explorer";
import { ToolErrorCode, createErrorEnvelope, createOkEnvelope } from "./envelope";
import { type StatusData, buildStatusData } from "./status-data";
import { toToolResult } from "./tool-result";

const logger = Logger.getInstance();

/** escalations の最大件数（エンベロープ肥大化防止） */
const MAX_ESCALATIONS = 50;

/**
 * 入力パラメータ: AI同期ツール
 */
interface AiSyncInput {
	/** true の場合はレビュー段でマーカーを変更しない（sync 段の adopt は行う） */
	dryRun?: boolean;
}

/** mdait_aiSync の data 形式 */
interface AiSyncData {
	/** sync(adopt+align) 段の結果 */
	sync: {
		filesProcessed: number;
		filesFailed: number;
		adopted: number;
		alignCorrections: number;
		added: number;
		deleted: number;
		kept: number;
		orphanReviewed: number;
	};
	/** AIペアリング検証段の結果 */
	review: {
		filesWithReviewUnits: number;
		verified: number;
		approved: number;
		mismatch: number;
		partial: number;
		uncertain: number;
		keptBelowThreshold: number;
		errors: number;
		skipped: number;
	};
	autoApprove: {
		enabled: boolean;
		threshold: number;
	};
	dryRun: boolean;
	/** エスカレーション（mismatch/partial）の一覧。最大50件 */
	escalations: Array<{
		file: string;
		unitHash: string;
		title?: string;
		verdict: PairVerdict;
		confidence: number;
		reason: string;
		issues: string[];
	}>;
	/** 実行後の全体ステータス */
	status: StatusData;
}

/**
 * mdaitのAI同期ツール
 * sync(adopt+align) → AIペアリング検証 → レポートを束ねる薄い合成コマンド。
 * 取り込みと健全性監査を同一機能で兼ねる（docs/design/command_ai-sync.md 参照）。
 * 出力は共通エンベロープのJSON文字列。
 */
export class MdaitAiSyncTool implements vscode.LanguageModelTool<AiSyncInput> {
	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<AiSyncInput>,
		token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const dryRun = options.input.dryRun === true;
			logger.info("LanguageModelTool", "AI sync tool invoked", { dryRun });

			const config = Configuration.getInstance();
			const validationError = config.validate();
			if (validationError) {
				return toToolResult(createErrorEnvelope(validationError, ToolErrorCode.InternalError, validationError));
			}

			try {
				new FileExplorer();
			} catch {
				const message = vscode.l10n.t("No workspace folder is open.");
				return toToolResult(createErrorEnvelope(message, ToolErrorCode.NoWorkspace, message));
			}

			// AI初回チェック（prepareInvocationはside-effect禁止のためここで実施）
			const aiOnboarding = AIOnboarding.getInstance();
			if (!(await aiOnboarding.checkAndShowFirstUseDialog())) {
				const message = vscode.l10n.t("Translation cancelled by user.");
				return toToolResult(createErrorEnvelope(message, ToolErrorCode.UserDeclined, message));
			}

			const dummyProgress: vscode.Progress<{ message?: string; increment?: number }> = {
				report: () => {
					// No-op
				},
			};

			const outcome = await executeAiSync(config, { dryRun }, dummyProgress, token);
			if (outcome.aborted || !outcome.sync) {
				const message = vscode.l10n.t("Synchronization did not run. Check the mdait configuration.");
				return toToolResult(
					createErrorEnvelope(message, ToolErrorCode.InternalError, message, [
						"Check .mdait/mdait.json configuration (transPairs, primaryLang) and retry mdait_aiSync.",
					]),
				);
			}

			const data = buildAiSyncData(outcome, config);
			const summary = vscode.l10n.t(
				"AI sync completed: {0} adopted, {1} align-corrected; review {2} verified, {3} approved, {4} escalated ({5} mismatch / {6} partial), {7} kept, {8} errors.",
				data.sync.adopted,
				data.sync.alignCorrections,
				data.review.verified,
				data.review.approved,
				data.review.mismatch + data.review.partial,
				data.review.mismatch,
				data.review.partial,
				data.review.keptBelowThreshold + data.review.uncertain,
				data.review.errors,
			);

			return toToolResult(createOkEnvelope(summary, data, buildAiSyncNextActions(outcome)));
		} catch (error) {
			logger.error("LanguageModelTool", "Error in AI sync tool", formatError(error));
			const errorMessage = vscode.l10n.t("AI sync failed: {0}", (error as Error).message);
			return toToolResult(createErrorEnvelope(errorMessage, ToolErrorCode.InternalError, (error as Error).message));
		}
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<AiSyncInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.PreparedToolInvocation> {
		const dryRun = options.input.dryRun === true;
		const message = dryRun
			? vscode.l10n.t(
					"Run AI Sync (dry run)? Steps: (1) adopt existing translations, (2) AI-align mis-paired units, (3) AI pairing review. The review step changes no markers in dry run, but adopt still updates markers. Committing your workspace to git beforehand is recommended.",
				)
			: vscode.l10n.t(
					"Run AI Sync? Steps in order: (1) adopt existing translations (need:review), (2) AI-align mis-paired units, (3) AI pairing review (auto-approves high-confidence matches). It updates translation markers. Committing your workspace to git beforehand is recommended.",
				);
		return {
			invocationMessage: vscode.l10n.t("Running AI sync (adopt, align, review)..."),
			confirmationMessages: {
				title: vscode.l10n.t("Confirm AI Sync"),
				message,
			},
		};
	}
}

/**
 * AI同期結果からエンベロープの data を構築する。
 */
function buildAiSyncData(outcome: AiSyncOutcome, config: Configuration): AiSyncData {
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
	const toRelative = (filePath: string) => path.relative(workspaceRoot, filePath).replace(/\\/g, "/");
	const sync = outcome.sync;
	const agg = aggregateReviewResults(outcome.review);

	const escalations: AiSyncData["escalations"] = [];
	for (const fileResult of outcome.review) {
		for (const unit of fileResult.unitResults) {
			if (unit.action === "escalated" && escalations.length < MAX_ESCALATIONS) {
				escalations.push({
					file: toRelative(unit.filePath),
					unitHash: unit.unitHash,
					title: unit.title,
					verdict: unit.verdict ?? "uncertain",
					confidence: unit.confidence ?? 0,
					reason: unit.reason ?? "",
					issues: unit.issues,
				});
			}
		}
	}

	return {
		sync: {
			filesProcessed: sync?.totalFileCount ?? 0,
			filesFailed: sync?.errorCount ?? 0,
			adopted: sync?.totalAdopted ?? 0,
			alignCorrections: sync?.totalAlignCorrections ?? 0,
			added: sync?.totalAdded ?? 0,
			deleted: sync?.totalDeleted ?? 0,
			kept: sync?.totalKept ?? 0,
			orphanReviewed: sync?.totalOrphanReviewed ?? 0,
		},
		review: {
			filesWithReviewUnits: agg.filesWithUnits,
			verified: agg.verified,
			approved: agg.approved,
			mismatch: agg.mismatch,
			partial: agg.partial,
			uncertain: agg.uncertain,
			keptBelowThreshold: agg.keptBelowThreshold,
			errors: agg.errors,
			skipped: agg.skipped,
		},
		autoApprove: {
			enabled: config.aiSync.review.autoApprove,
			threshold: config.aiSync.review.autoApproveThreshold,
		},
		dryRun: outcome.dryRun,
		escalations,
		status: buildStatusData(StatusManager.getInstance().getStatusItemTree().getFilesAll(), false),
	};
}
