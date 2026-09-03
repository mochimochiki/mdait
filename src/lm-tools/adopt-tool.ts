import * as path from "node:path";
import * as vscode from "vscode";
import { buildAdoptStepList } from "../commands/adopt/adopt-command";
import { executeAdopt } from "../commands/adopt/adopt-core";
import { writeAdoptReport } from "../commands/adopt/adopt-report-file";
import { type AdoptOutcome, type AdoptStageError, buildAdoptNextActions } from "../commands/adopt/adopt-result";
import { AUTO_APPROVE_THRESHOLD } from "../commands/ai-review/review-constants";
import { type PairVerdict, aggregateReviewResults } from "../commands/ai-review/review-result";
import { getSelectedScopeFiles } from "../commands/shared/status-scope";
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
 * 入力パラメータ: 取り込みウィザードツール
 */
interface AdoptInput {
	/** true の場合はレビュー段でマーカーを変更せず、用語集・TM 段をスキップする（sync 段の adopt は行う） */
	dryRun?: boolean;
	/** 用語集構築段（term.detect → term.expand）を実行するか（既定 false） */
	buildGlossary?: boolean;
	/** TM構築段（tm.commit）を実行するか（既定 false） */
	buildTm?: boolean;
}

/** mdait_adopt の data 形式 */
interface AdoptData {
	/** sync(adopt+align) 段の結果 */
	sync: {
		filesProcessed: number;
		filesFailed: number;
		/** この実行が取り消されたか。**失敗ではない**（ADR-260903-05） */
		cancelled: boolean;
		adopted: number;
		alignCorrections: number;
		added: number;
		deleted: number;
		kept: number;
		orphanReviewed: number;
	};
	/** AI翻訳レビュー段の結果 */
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
	/** 用語集構築段の結果（buildGlossary 時のみ） */
	term?: {
		detected: number;
		expanded: number;
		remaining: number;
	};
	/** TM構築段の結果（buildTm 時のみ） */
	tm?: {
		files: number;
		processedUnits: number;
		newEntries: number;
		existingEntries: number;
		warnedEntries: number;
		errorUnits: number;
	};
	/** オプション段の失敗記録 */
	stageErrors: AdoptStageError[];
	autoApprove: {
		enabled: boolean;
		threshold: number;
	};
	dryRun: boolean;
	/** 統合レポート（Markdown 実ファイル）のワークスペース相対パス。書き出せなかった場合は undefined */
	reportPath?: string;
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
 * mdaitの既存翻訳取り込みウィザードツール（旧 mdait_aiSync）。
 * sync(adopt+align) → AI翻訳レビュー →（オプション）用語集構築 → TM構築 → レポートを
 * 束ねる薄い合成コマンド（docs/design/command_adopt.md 参照）。
 * 出力は共通エンベロープのJSON文字列。
 */
export class MdaitAdoptTool implements vscode.LanguageModelTool<AdoptInput> {
	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<AdoptInput>,
		token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const dryRun = options.input.dryRun === true;
			const buildGlossary = options.input.buildGlossary === true;
			const buildTm = options.input.buildTm === true;
			logger.info("LanguageModelTool", "Adopt tool invoked", { dryRun, buildGlossary, buildTm });

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

			const outcome = await executeAdopt(config, { dryRun, buildGlossary, buildTm }, dummyProgress, token);
			if (outcome.aborted || !outcome.sync) {
				const message = vscode.l10n.t("Synchronization did not run. Check the mdait configuration.");
				return toToolResult(
					createErrorEnvelope(message, ToolErrorCode.InternalError, message, [
						"Check .mdait/mdait.json configuration (transPairs, primaryLang) and retry mdait_adopt.",
					]),
				);
			}

			// 人間が後から確認できるよう、レポートは実ファイルにも残す（プレビュー表示はしない）。
			// dryRun では書かない — 直前の本番実行のレポートを試行結果で上書きしないため
			// （dryRun の結果はこのエンベロープに全て入っている）。
			const reportUri = dryRun ? undefined : await writeAdoptReport(config, outcome);

			const data = buildAdoptData(outcome, config, reportUri?.fsPath);
			const summaryParts = [
				vscode.l10n.t(
					"Adoption completed: {0} adopted, {1} align-corrected; review {2} verified, {3} approved, {4} escalated ({5} mismatch / {6} partial), {7} kept, {8} errors.",
					data.sync.adopted,
					data.sync.alignCorrections,
					data.review.verified,
					data.review.approved,
					data.review.mismatch + data.review.partial,
					data.review.mismatch,
					data.review.partial,
					data.review.keptBelowThreshold + data.review.uncertain,
					data.review.errors,
				),
			];
			if (data.term) {
				summaryParts.push(
					vscode.l10n.t("Glossary: {0} detected, {1} expanded.", data.term.detected, data.term.expanded),
				);
			}
			if (data.tm) {
				summaryParts.push(vscode.l10n.t("TM: {0} new, {1} updated.", data.tm.newEntries, data.tm.existingEntries));
			}
			if (data.stageErrors.length > 0) {
				summaryParts.push(vscode.l10n.t("{0} step error(s).", data.stageErrors.length));
			}

			return toToolResult(createOkEnvelope(summaryParts.join(" "), data, buildAdoptNextActions(outcome)));
		} catch (error) {
			logger.error("LanguageModelTool", "Error in adopt tool", formatError(error));
			const errorMessage = vscode.l10n.t("Adoption failed: {0}", (error as Error).message);
			return toToolResult(createErrorEnvelope(errorMessage, ToolErrorCode.InternalError, (error as Error).message));
		}
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<AdoptInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.PreparedToolInvocation> {
		const dryRun = options.input.dryRun === true;
		const adoptOptions = {
			buildGlossary: options.input.buildGlossary === true,
			buildTm: options.input.buildTm === true,
		};
		// レビュー段の表記を aiReview.autoApprove に追従させる（コマンド側の確認UIと共通のステップ列挙）
		const steps = buildAdoptStepList(adoptOptions, Configuration.getInstance().aiReview.autoApprove);
		const message = dryRun
			? vscode.l10n.t(
					"Adopt existing translations (dry run)? Steps: adopt existing translations, AI-align mis-paired units, AI translation review. The review step changes no markers in dry run and the glossary/TM steps are skipped, but adopt still updates markers. Committing your workspace to git beforehand is recommended.",
				)
			: vscode.l10n.t(
					"Adopt existing translations? Steps: {0}. This updates translation markers{1}. Committing your workspace to git beforehand is recommended.",
					steps.join(", "),
					adoptOptions.buildGlossary || adoptOptions.buildTm ? vscode.l10n.t(" and writes to the glossary/TM") : "",
				);
		return {
			invocationMessage: vscode.l10n.t("Adopting existing translations..."),
			confirmationMessages: {
				title: vscode.l10n.t("Confirm Adopt Existing Translations"),
				message,
			},
		};
	}
}

/**
 * 取り込み結果からエンベロープの data を構築する。
 */
function buildAdoptData(outcome: AdoptOutcome, config: Configuration, reportFilePath?: string): AdoptData {
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
	const toRelative = (filePath: string) => path.relative(workspaceRoot, filePath).replace(/\\/g, "/");
	const sync = outcome.sync;
	const agg = aggregateReviewResults(outcome.review);

	const escalations: AdoptData["escalations"] = [];
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
			cancelled: sync?.cancelled ?? false,
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
		term: outcome.term,
		tm: outcome.tm,
		stageErrors: outcome.stageErrors,
		autoApprove: {
			enabled: config.aiReview.autoApprove,
			threshold: AUTO_APPROVE_THRESHOLD,
		},
		dryRun: outcome.dryRun,
		reportPath: reportFilePath ? toRelative(reportFilePath) : undefined,
		escalations,
		status: buildStatusData(getSelectedScopeFiles(StatusManager.getInstance().getStatusItemTree()), false),
	};
}
