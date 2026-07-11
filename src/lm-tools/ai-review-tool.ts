import * as path from "node:path";
import * as vscode from "vscode";
import { executeAiReviewForFiles } from "../commands/ai-sync/review-command";
import { AUTO_APPROVE_THRESHOLD } from "../commands/ai-sync/review-constants";
import { resolveReviewTargets } from "../commands/ai-sync/review-targets";
import { type AiReviewFileResult, type PairVerdict, aggregateReviewResults } from "../commands/ai-sync/review-result";
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
 * 入力パラメータ: AIペアリング検証ツール
 */
interface AiReviewInput {
	/** 対象スコープ（ファイル/ディレクトリ）。省略時は全ターゲットディレクトリ */
	path?: string;
	/** true の場合はマーカーを一切変更せずレポートのみ返す */
	dryRun?: boolean;
	/**
	 * 検証範囲（既定 "pending"）。
	 * - "pending": need:review ユニットのみ
	 * - "audit": 確定済みペア（from あり・need なし）も監査し、ドリフト検出時に need:review を付与
	 */
	mode?: "pending" | "audit";
}

/** mdait_aiReview の data 形式 */
interface AiReviewData {
	files: {
		/** 検査したターゲットファイル数 */
		scanned: number;
		/** need:review ユニットを持っていたファイル数 */
		withReviewUnits: number;
	};
	units: {
		verified: number;
		approved: number;
		mismatch: number;
		partial: number;
		uncertain: number;
		/** match だが閾値未満/issuesあり/autoApprove無効で保留されたユニット数 */
		keptBelowThreshold: number;
		/** audit: 確定済みペアにドリフトを検出し need:review を付与した数 */
		flagged: number;
		/** audit: 確定済みペアを検証しクリーンだった数（変更なし） */
		audited: number;
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
 * mdaitのAIペアリング検証ツール
 * adopt 済みペア（from + need:review）を GitHub Copilot Chat から AI でトリアージする。
 * 出力は共通エンベロープのJSON文字列（docs/design/agent-orchestration.md 参照）
 */
export class MdaitAiReviewTool implements vscode.LanguageModelTool<AiReviewInput> {
	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<AiReviewInput>,
		token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const inputPath = options.input.path;
			const dryRun = options.input.dryRun === true;
			const mode = options.input.mode === "audit" ? "audit" : "pending";
			logger.info("LanguageModelTool", "AI review tool invoked", { inputPath, dryRun, mode });

			const config = Configuration.getInstance();
			const validationError = config.validate();
			if (validationError) {
				return toToolResult(
					createErrorEnvelope(validationError, ToolErrorCode.InternalError, validationError),
				);
			}

			let fileExplorer: FileExplorer;
			try {
				fileExplorer = new FileExplorer();
			} catch {
				const message = vscode.l10n.t("No workspace folder is open.");
				return toToolResult(createErrorEnvelope(message, ToolErrorCode.NoWorkspace, message));
			}

			// AI初回チェック（prepareInvocationはside-effect禁止のためここで実施）
			const aiOnboarding = AIOnboarding.getInstance();
			const shouldProceed = await aiOnboarding.checkAndShowFirstUseDialog();
			if (!shouldProceed) {
				const message = vscode.l10n.t("Translation cancelled by user.");
				return toToolResult(createErrorEnvelope(message, ToolErrorCode.UserDeclined, message));
			}

			const targetFiles = await resolveReviewTargets(inputPath, config, fileExplorer);
			if (targetFiles.length === 0) {
				const message = vscode.l10n.t("No target files found for the given scope: {0}", inputPath ?? "workspace");
				return toToolResult(createErrorEnvelope(message, ToolErrorCode.InvalidPath, message));
			}

			const dummyProgress: vscode.Progress<{ message?: string; increment?: number }> = {
				report: () => {
					// No-op
				},
			};

			const results = await executeAiReviewForFiles(targetFiles, config, { dryRun, mode }, dummyProgress, token);
			const data = buildAiReviewData(results, targetFiles.length, dryRun, config);

			const summary = vscode.l10n.t(
				"AI pairing review completed ({8}): {0} verified, {1} approved, {2} flagged, {3} escalated ({4} mismatch / {5} partial), {6} kept, {7} errors across {9} file(s).",
				data.units.verified,
				data.units.approved,
				data.units.flagged,
				data.units.mismatch + data.units.partial,
				data.units.mismatch,
				data.units.partial,
				data.units.keptBelowThreshold + data.units.uncertain,
				data.units.errors,
				mode,
				targetFiles.length,
			);

			return toToolResult(createOkEnvelope(summary, data, buildAiReviewNextActions(data)));
		} catch (error) {
			logger.error("LanguageModelTool", "Error in AI review tool", formatError(error));
			const errorMessage = vscode.l10n.t("AI review failed: {0}", (error as Error).message);
			return toToolResult(
				createErrorEnvelope(errorMessage, ToolErrorCode.InternalError, (error as Error).message),
			);
		}
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<AiReviewInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.PreparedToolInvocation> {
		const scopeLabel = options.input.path ?? vscode.l10n.t("all translation pairs");
		if (options.input.dryRun === true) {
			// dryRun はマーカーを変更しないが AI を使用するため確認を出す
			return {
				invocationMessage: vscode.l10n.t("Reviewing translation pairings with AI (dry run)..."),
				confirmationMessages: {
					title: vscode.l10n.t("Confirm AI Pairing Review (Dry Run)"),
					message: vscode.l10n.t(
						"Verify adopted translation pairings for {0} with AI? Dry run: no markers are changed, only a report is returned.",
						scopeLabel,
					),
				},
			};
		}
		if (options.input.mode === "audit") {
			return {
				invocationMessage: vscode.l10n.t("Auditing all translation pairings with AI..."),
				confirmationMessages: {
					title: vscode.l10n.t("Confirm AI Pairing Audit"),
					message: vscode.l10n.t(
						"Audit all confirmed translation pairings for {0} with AI? Confirmed pairs whose translation is not faithful/complete are reported only (their markers are NOT changed); need:review units are triaged as usual (high-confidence matches are cleared, per aiSync.review settings).",
						scopeLabel,
					),
				},
			};
		}
		return {
			invocationMessage: vscode.l10n.t("Reviewing translation pairings with AI..."),
			confirmationMessages: {
				title: vscode.l10n.t("Confirm AI Pairing Review"),
				message: vscode.l10n.t(
					"Verify adopted translation pairings for {0} with AI? High-confidence matches will have their need:review flag removed (controlled by aiSync.review settings).",
					scopeLabel,
				),
			},
		};
	}
}

/**
 * 検証結果からエンベロープの data を構築する。
 */
function buildAiReviewData(
	results: AiReviewFileResult[],
	scannedFiles: number,
	dryRun: boolean,
	config: Configuration,
): AiReviewData {
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
	const toRelative = (filePath: string) => path.relative(workspaceRoot, filePath).replace(/\\/g, "/");

	const agg = aggregateReviewResults(results);
	const data: AiReviewData = {
		files: {
			scanned: scannedFiles,
			withReviewUnits: agg.filesWithUnits,
		},
		units: {
			verified: agg.verified,
			approved: agg.approved,
			mismatch: agg.mismatch,
			partial: agg.partial,
			uncertain: agg.uncertain,
			keptBelowThreshold: agg.keptBelowThreshold,
			flagged: agg.flagged,
			audited: agg.audited,
			errors: agg.errors,
			skipped: agg.skipped,
		},
		autoApprove: {
			enabled: config.aiSync.review.autoApprove,
			threshold: AUTO_APPROVE_THRESHOLD,
		},
		dryRun,
		escalations: [],
		status: buildStatusData(StatusManager.getInstance().getStatusItemTree().getFilesAll(), false),
	};

	for (const fileResult of results) {
		for (const unit of fileResult.unitResults) {
			// escalated（need:review 維持）と flagged（audit で need:review を付与）はどちらも
			// ドリフト検出であり、エージェントが確認すべき対象なのでまとめて列挙する。
			if ((unit.action === "escalated" || unit.action === "flagged") && data.escalations.length < MAX_ESCALATIONS) {
				data.escalations.push({
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
	return data;
}

/**
 * 検証結果に応じたエージェント向け次アクションを生成する。
 */
function buildAiReviewNextActions(data: AiReviewData): string[] {
	const nextActions: string[] = [];
	if (data.units.mismatch > 0) {
		nextActions.push(
			`${data.units.mismatch} unit(s) look mis-paired (verdict:mismatch). Inspect the heading correspondence in the escalations list, fix the document structure (reorder/insert sections) manually, then run mdait_sync again to re-pair.`,
		);
	}
	if (data.units.partial > 0) {
		nextActions.push(
			`${data.units.partial} unit(s) look like incomplete translations (verdict:partial). Check the issues in the escalations list; either fix the translation manually or remove the translated body and set need:translate to re-translate with mdait_translate.`,
		);
	}
	if (data.units.flagged > 0) {
		nextActions.push(
			`${data.units.flagged} confirmed pair(s) no longer look like a faithful and complete translation of their source (adopted mis-pairing or hand-edited degradation). The audit reports these but does NOT change their markers. Inspect the escalations list; if a pair is genuinely off, fix the translation manually or remove the translated body and set need:translate to re-translate with mdait_translate. (Source revisions are already caught deterministically by mdait_sync as need:revise and are not audited here.)`,
		);
	}
	if (data.units.uncertain + data.units.keptBelowThreshold > 0) {
		nextActions.push(
			`${data.units.uncertain + data.units.keptBelowThreshold} unit(s) were kept as need:review (uncertain or below the auto-approve threshold). Review them manually and remove the need:review flag to approve.`,
		);
	}
	if (data.dryRun && data.units.approved === 0 && data.units.verified > 0) {
		nextActions.push(
			'This was a dry run: no markers were changed. Re-run mdait_aiReview without dryRun to apply auto-approval.',
		);
	}
	if (data.units.approved > 0) {
		nextActions.push(
			`${data.units.approved} unit(s) were auto-approved (need:review removed). Run mdait_tm (action:"commit") to register the approved pairs into the translation memory.`,
		);
	}
	if (nextActions.length === 0) {
		if (data.units.audited > 0) {
			nextActions.push(
				`Audit complete: all ${data.units.audited} confirmed pair(s) look healthy (no drift). Run mdait_getStatus to confirm the overall state.`,
			);
		} else {
			nextActions.push(
				"No pairs matched the selected scope. Run mdait_getStatus to confirm the overall state, or mdait_sync (adopt:true) first if you are onboarding an existing translated site.",
			);
		}
	}
	return nextActions;
}
