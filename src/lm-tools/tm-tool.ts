import * as fs from "node:fs"; // @important Node.jsのbuildinモジュールのimportでは`node:`を使用
import * as path from "node:path";
import * as vscode from "vscode";
import { executeTmCommitForFile } from "../commands/tm/command-commit";
import type { TmSkipReasonBreakdown } from "../commands/tm/commit-filter";
import { tmOptimizeCommand } from "../commands/tm/command-optimize";
import { Configuration } from "../infra/config/configuration";
import { Logger, formatError } from "../infra/logging/logger";
import { AIOnboarding } from "../infra/onboarding/ai-onboarding";
import { FileExplorer } from "../infra/workspace/file-explorer";
import { ToolErrorCode, createErrorEnvelope, createOkEnvelope } from "./envelope";
import { toToolResult } from "./tool-result";

const logger = Logger.getInstance();

/**
 * 入力パラメータ: 翻訳メモリツール
 */
interface TmInput {
	/** 実行するアクション */
	action: "commit" | "optimize";
	/** 対象スコープ（ファイル/ディレクトリ）。省略時は全ターゲットディレクトリ（commitのみ） */
	path?: string;
}

/** mdait_tm の data 形式 */
interface TmData {
	action: "commit" | "optimize";
	/** commit: 処理したファイル数 */
	files?: number;
	/** commit: 処理したユニット数 */
	processedUnits?: number;
	/** commit: 新規TU数 */
	newEntries?: number;
	/** commit: 既存更新TU数 */
	updatedEntries?: number;
	/** commit: 警告件数 */
	warnedEntries?: number;
	/** commit: エラーユニット数 */
	errorUnits?: number;
	/** commit: スキップ理由内訳（なぜコミットされないかの診断用） */
	skipped?: TmSkipReasonBreakdown;
	/** optimize: 再重み付けしたTMエントリ数 */
	entryCount?: number;
}

/**
 * mdaitの翻訳メモリツール（commit / optimize）
 * GitHub Copilot ChatからTM登録・TM最適化を実行する。
 * 出力は共通エンベロープのJSON文字列（docs/design/agent-orchestration.md 参照）
 */
export class MdaitTmTool implements vscode.LanguageModelTool<TmInput> {
	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<TmInput>,
		token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const { action } = options.input;
			const inputPath = options.input.path;
			logger.info("LanguageModelTool", "TM tool invoked", { action, inputPath });

			if (action !== "commit" && action !== "optimize") {
				const message = vscode.l10n.t("Unknown action: {0}", String(action));
				return toToolResult(createErrorEnvelope(message, ToolErrorCode.InvalidPath, message));
			}

			const config = Configuration.getInstance();
			const validationError = config.validate();
			if (validationError) {
				return toToolResult(
					createErrorEnvelope(validationError, ToolErrorCode.InternalError, validationError),
				);
			}
			if (!config.getTmEnabled()) {
				const message = vscode.l10n.t("TM feature is disabled. Enable it in mdait.json.");
				return toToolResult(
					createErrorEnvelope(message, ToolErrorCode.InternalError, message, [
						'Set "tm": { "enabled": true } in .mdait/mdait.json, then retry.',
					]),
				);
			}

			if (action === "optimize") {
				const result = await tmOptimizeCommand();
				if (!result) {
					const message = vscode.l10n.t("TM optimize failed.");
					return toToolResult(createErrorEnvelope(message, ToolErrorCode.InternalError, message));
				}
				const summary = vscode.l10n.t("TM optimize completed: {0} entries reweighted.", result.entryCount);
				return toToolResult(
					createOkEnvelope(summary, { action, entryCount: result.entryCount } satisfies TmData),
				);
			}

			// commit
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

			const targetFiles = await resolveCommitTargets(inputPath, config, fileExplorer);
			if (targetFiles.length === 0) {
				const message = vscode.l10n.t("No target files found for the given scope: {0}", inputPath ?? "workspace");
				return toToolResult(createErrorEnvelope(message, ToolErrorCode.InvalidPath, message));
			}

			const dummyProgress: vscode.Progress<{ message?: string; increment?: number }> = {
				report: () => {
					// No-op
				},
			};

			const data: TmData = {
				action,
				files: targetFiles.length,
				processedUnits: 0,
				newEntries: 0,
				updatedEntries: 0,
				warnedEntries: 0,
				errorUnits: 0,
				skipped: {
					noFrom: 0,
					needTranslate: 0,
					needRevise: 0,
					needReview: 0,
					needKeep: 0,
				},
			};

			for (const file of targetFiles) {
				if (token.isCancellationRequested) {
					break;
				}
				try {
					const result = await executeTmCommitForFile(file, config, dummyProgress, token);
					data.processedUnits = (data.processedUnits ?? 0) + result.processedUnits;
					data.newEntries = (data.newEntries ?? 0) + result.newEntries;
					data.updatedEntries = (data.updatedEntries ?? 0) + result.existingEntries;
					data.warnedEntries = (data.warnedEntries ?? 0) + result.warnedEntries;
					data.errorUnits = (data.errorUnits ?? 0) + result.errorUnits;
					if (result.skipReasons && data.skipped) {
						data.skipped.noFrom += result.skipReasons.noFrom;
						data.skipped.needTranslate += result.skipReasons.needTranslate;
						data.skipped.needRevise += result.skipReasons.needRevise;
						data.skipped.needReview += result.skipReasons.needReview;
						data.skipped.needKeep += result.skipReasons.needKeep;
					}
				} catch (error) {
					logger.warn("LanguageModelTool", "TM commit file error", {
						file,
						...formatError(error),
					});
					data.errorUnits = (data.errorUnits ?? 0) + 1;
				}
			}

			const summary = vscode.l10n.t(
				"TM commit completed: {0} new, {1} updated, {2} warnings, {3} errors across {4} file(s).",
				data.newEntries ?? 0,
				data.updatedEntries ?? 0,
				data.warnedEntries ?? 0,
				data.errorUnits ?? 0,
				targetFiles.length,
			);

			const nextActions: string[] = [];
			const skipped = data.skipped;
			if (skipped) {
				if (skipped.needTranslate + skipped.needRevise > 0) {
					nextActions.push(
						`${skipped.needTranslate + skipped.needRevise} unit(s) were skipped because they still need translation/revision. Run mdait_translate first, then re-run mdait_tm (action:"commit").`,
					);
				}
				if (skipped.needReview > 0) {
					nextActions.push(
						`${skipped.needReview} unit(s) were skipped because they are flagged need:review. Resolve the reviews (remove the flag after checking), then re-run mdait_tm (action:"commit").`,
					);
				}
			}
			if (nextActions.length === 0) {
				nextActions.push(
					'All committable units are in the TM. Re-running mdait_tm (action:"commit") on an unchanged workspace reports zero new entries (idempotent steady state).',
				);
			}
			return toToolResult(createOkEnvelope(summary, data, nextActions));
		} catch (error) {
			logger.error("LanguageModelTool", "Error in TM tool", formatError(error));
			const errorMessage = vscode.l10n.t("TM operation failed: {0}", (error as Error).message);
			return toToolResult(
				createErrorEnvelope(errorMessage, ToolErrorCode.InternalError, (error as Error).message),
			);
		}
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<TmInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.PreparedToolInvocation> {
		const { action } = options.input;
		const scopeLabel = options.input.path ?? vscode.l10n.t("all translation pairs");
		if (action === "optimize") {
			return {
				invocationMessage: vscode.l10n.t("Optimizing translation memory..."),
				confirmationMessages: {
					title: vscode.l10n.t("Confirm TM Optimize"),
					message: vscode.l10n.t(
						"Recompute TM entry weights from current source content? This rewrites translations.tmx (no AI is used).",
					),
				},
			};
		}
		return {
			invocationMessage: vscode.l10n.t("Committing to translation memory..."),
			confirmationMessages: {
				title: vscode.l10n.t("Confirm TM Commit"),
				message: vscode.l10n.t(
					"Commit translated units to the translation memory for {0}? This uses AI for sentence alignment and updates translations.tmx.",
					scopeLabel,
				),
			},
		};
	}
}

/**
 * commit対象のターゲットMDファイル群を解決する。
 * - path省略: 全transPairのターゲットディレクトリ配下
 * - pathがファイル: そのファイル（ターゲットであること）
 * - pathがディレクトリ: 配下のターゲットMDファイル
 */
async function resolveCommitTargets(
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
