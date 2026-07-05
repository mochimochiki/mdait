import * as fs from "node:fs"; // @important Node.jsのbuilt-inモジュールのimportでは`node:`を使用
import * as path from "node:path";
import * as vscode from "vscode";
import { executeAiReviewForFiles } from "../commands/ai-sync/review-command";
import type { AiReviewFileResult, PairVerdict } from "../commands/ai-sync/review-result";
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
			logger.info("LanguageModelTool", "AI review tool invoked", { inputPath, dryRun });

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

			const results = await executeAiReviewForFiles(targetFiles, config, { dryRun }, dummyProgress, token);
			const data = buildAiReviewData(results, targetFiles.length, dryRun, config);

			const summary = vscode.l10n.t(
				"AI pairing review completed: {0} verified, {1} approved, {2} escalated ({3} mismatch / {4} partial), {5} kept, {6} errors across {7} file(s).",
				data.units.verified,
				data.units.approved,
				data.units.mismatch + data.units.partial,
				data.units.mismatch,
				data.units.partial,
				data.units.keptBelowThreshold + data.units.uncertain,
				data.units.errors,
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

	const data: AiReviewData = {
		files: {
			scanned: scannedFiles,
			withReviewUnits: results.filter((r) => r.unitResults.length > 0).length,
		},
		units: {
			verified: 0,
			approved: 0,
			mismatch: 0,
			partial: 0,
			uncertain: 0,
			keptBelowThreshold: 0,
			errors: 0,
			skipped: 0,
		},
		autoApprove: {
			enabled: config.aiSync.review.autoApprove,
			threshold: config.aiSync.review.autoApproveThreshold,
		},
		dryRun,
		escalations: [],
		status: buildStatusData(StatusManager.getInstance().getStatusItemTree().getFilesAll(), false),
	};

	for (const fileResult of results) {
		data.units.verified += fileResult.verified;
		data.units.approved += fileResult.approved;
		data.units.errors += fileResult.errors;
		data.units.skipped += fileResult.skipped;
		for (const unit of fileResult.unitResults) {
			if (unit.action === "escalated") {
				if (unit.verdict === "mismatch") {
					data.units.mismatch++;
				} else {
					data.units.partial++;
				}
				if (data.escalations.length < MAX_ESCALATIONS) {
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
			} else if (unit.action === "kept") {
				if (unit.verdict === "uncertain") {
					data.units.uncertain++;
				} else {
					data.units.keptBelowThreshold++;
				}
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
		nextActions.push(
			"No units with need:review were found. Run mdait_getStatus to confirm the overall state, or mdait_sync (adopt:true) first if you are onboarding an existing translated site.",
		);
	}
	return nextActions;
}

/**
 * レビュー対象のターゲットMDファイル群を解決する。
 * - path省略: 全transPairのターゲットディレクトリ配下
 * - pathがファイル: そのファイル（ターゲットであること）
 * - pathがディレクトリ: 配下のターゲットMDファイル
 */
async function resolveReviewTargets(
	inputPath: string | undefined,
	config: Configuration,
	fileExplorer: FileExplorer,
): Promise<string[]> {
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	const configBase = config.getConfigBaseDir() ?? workspaceRoot ?? "";

	const collectFromDir = async (dir: string): Promise<string[]> => {
		const pattern = new vscode.RelativePattern(dir, "**/*.md");
		const found = await vscode.workspace.findFiles(pattern, config.ignoredPatterns);
		return found.map((f) => f.fsPath).filter((f) => fileExplorer.isTargetFile(f, config));
	};

	if (!inputPath) {
		const results: string[] = [];
		const seen = new Set<string>();
		for (const pair of config.transPairs) {
			const dir = path.isAbsolute(pair.targetDir) ? pair.targetDir : path.resolve(configBase, pair.targetDir);
			if (!fs.existsSync(dir)) {
				continue;
			}
			for (const file of await collectFromDir(dir)) {
				if (!seen.has(file)) {
					seen.add(file);
					results.push(file);
				}
			}
		}
		return results;
	}

	const absPath = path.isAbsolute(inputPath)
		? inputPath
		: workspaceRoot
			? path.resolve(workspaceRoot, inputPath)
			: inputPath;
	if (!fs.existsSync(absPath)) {
		return [];
	}
	if (fs.statSync(absPath).isDirectory()) {
		return collectFromDir(absPath);
	}
	return fileExplorer.isTargetFile(absPath, config) ? [absPath] : [];
}
