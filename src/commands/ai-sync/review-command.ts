/**
 * @file review-command.ts
 * @description
 *   AIペアリング検証コマンドのエントリーポイント。
 *   StatusTree のファイル/ディレクトリから呼び出され、adopt 済みペア
 *   （from + need:review）を AI で検証して自動承認/エスカレーションする。
 *   withProgress パターンで進捗表示・キャンセル対応（tm/command-commit.ts と同構成）。
 * @module commands/ai-sync/review-command
 */
import * as path from "node:path";
import * as vscode from "vscode";
import type { StatusItem } from "../../core/status/status-item";
import { Configuration } from "../../infra/config/configuration";
import { AIServiceBuilder } from "../../infra/llm/ai-service-builder";
import { Logger, formatError } from "../../infra/logging/logger";
import { AIOnboarding } from "../../infra/onboarding/ai-onboarding";
import { FileExplorer } from "../../infra/workspace/file-explorer";
import { PromptProvider } from "../../prompts";
import { PairVerifier } from "./pair-verifier";
import { type AiReviewOptions, executeAiReviewForFile } from "./review-core";
import type { AiReviewFileResult } from "./review-result";
import { AiReviewResultContentProvider } from "./review-result-provider";

const logger = Logger.getInstance();

/**
 * AIService と PromptProvider から PairVerifier を構築する。
 * LM tool（mdait_aiReview）からも再利用される。
 */
export async function buildPairVerifier(config: Configuration): Promise<PairVerifier> {
	const aiService = await new AIServiceBuilder().build(config.ai);
	const promptProvider = PromptProvider.getInstance();
	return new PairVerifier(aiService, (id, variables) => promptProvider.getPromptParts(id, variables));
}

/**
 * 複数ファイルに対してAIペアリング検証を実行する。
 * 1ファイルの失敗は記録して続行する（tm.commit と同方針）。
 */
export async function executeAiReviewForFiles(
	files: string[],
	config: Configuration,
	options: AiReviewOptions,
	progress: vscode.Progress<{ message?: string; increment?: number }>,
	token: vscode.CancellationToken,
): Promise<AiReviewFileResult[]> {
	const verifier = await buildPairVerifier(config);
	const results: AiReviewFileResult[] = [];

	for (let i = 0; i < files.length; i++) {
		if (token.isCancellationRequested) {
			break;
		}
		if (files.length > 1) {
			progress.report({
				message: vscode.l10n.t("{0}/{1} files", i + 1, files.length),
				increment: 100 / files.length,
			});
		}
		try {
			results.push(await executeAiReviewForFile(files[i], config, verifier, options, progress, token));
		} catch (error) {
			logger.warn("aiSync", "File review error", {
				file: files[i],
				...formatError(error),
			});
			results.push({
				filePath: files[i],
				verified: 0,
				approved: 0,
				escalated: 0,
				kept: 0,
				skipped: 0,
				errors: 1,
				unitResults: [
					{
						filePath: files[i],
						unitHash: "",
						fromHash: "",
						issues: [],
						action: "error",
						reason: (error as Error).message,
					},
				],
				markersChanged: false,
			});
		}
	}
	return results;
}

/**
 * ファイル単位のAIペアリング検証コマンド（StatusTreeから呼び出し）
 */
export async function aiReviewFileCommand(item?: StatusItem): Promise<AiReviewFileResult[] | undefined> {
	if (!item || !("filePath" in item)) {
		vscode.window.showErrorMessage(vscode.l10n.t("Invalid file item"));
		return;
	}
	const filePath = (item as { filePath: string }).filePath;
	return runAiReviewWithProgress([filePath], path.basename(filePath));
}

/**
 * ディレクトリ単位のAIペアリング検証コマンド（StatusTreeから呼び出し）
 */
export async function aiReviewDirectoryCommand(item?: StatusItem): Promise<AiReviewFileResult[] | undefined> {
	if (!item || !("dirPath" in item)) {
		vscode.window.showErrorMessage(vscode.l10n.t("Invalid directory item"));
		return;
	}
	const dirPath = (item as { dirPath: string }).dirPath;

	const config = Configuration.getInstance();
	const validationError = config.validate();
	if (validationError) {
		vscode.window.showErrorMessage(validationError);
		return;
	}

	const confirm = await vscode.window.showInformationMessage(
		vscode.l10n.t("Run AI pairing review for all files in directory '{0}'?", path.basename(dirPath)),
		vscode.l10n.t("Yes"),
		vscode.l10n.t("No"),
	);
	if (confirm !== vscode.l10n.t("Yes")) {
		return;
	}

	const fileExplorer = new FileExplorer();
	const files = (await fileExplorer.findFilesInDirectory(dirPath, [".md"], "**/*.md", config.ignoredPatterns)).filter(
		(file) => fileExplorer.isTargetFile(file, config),
	);
	if (files.length === 0) {
		vscode.window.showInformationMessage(vscode.l10n.t("No target files found in directory."));
		return;
	}
	return runAiReviewWithProgress(files, path.basename(dirPath));
}

/**
 * バリデーション・AIオンボーディング・進捗表示つきでAIペアリング検証を実行する共通経路。
 */
async function runAiReviewWithProgress(files: string[], scopeLabel: string): Promise<AiReviewFileResult[] | undefined> {
	const config = Configuration.getInstance();
	const validationError = config.validate();
	if (validationError) {
		vscode.window.showErrorMessage(validationError);
		return;
	}

	const aiOnboarding = AIOnboarding.getInstance();
	const shouldProceed = await aiOnboarding.checkAndShowFirstUseDialog();
	if (!shouldProceed) {
		return;
	}

	return await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: vscode.l10n.t("AI Pairing Review: {0}", scopeLabel),
			cancellable: true,
		},
		async (progress, token) => {
			try {
				const results = await executeAiReviewForFiles(files, config, {}, progress, token);
				showAiReviewResult(results);
				await showAiReviewPreview(results);
				return results;
			} catch (error) {
				logger.error("aiSync", "AI review failed", {
					scope: scopeLabel,
					...formatError(error),
				});
				vscode.window.showErrorMessage(vscode.l10n.t("AI review error: {0}", (error as Error).message));
				return undefined;
			}
		},
	);
}

/**
 * AIペアリング検証結果を通知表示する。
 */
function showAiReviewResult(results: AiReviewFileResult[]): void {
	const approved = results.reduce((sum, r) => sum + r.approved, 0);
	const escalated = results.reduce((sum, r) => sum + r.escalated, 0);
	const kept = results.reduce((sum, r) => sum + r.kept, 0);
	const errors = results.reduce((sum, r) => sum + r.errors, 0);
	const verified = results.reduce((sum, r) => sum + r.verified, 0);

	if (verified === 0 && errors === 0) {
		vscode.window.showInformationMessage(vscode.l10n.t("AI review: no units with need:review were found."));
		return;
	}

	const message = vscode.l10n.t(
		"AI review completed: {0} approved, {1} escalated, {2} kept, {3} errors",
		approved,
		escalated,
		kept,
		errors,
	);
	if (escalated > 0 || errors > 0) {
		vscode.window.showWarningMessage(message);
	} else {
		vscode.window.showInformationMessage(message);
	}
}

/**
 * 検証結果のプレビュードキュメントを開く。1件以上検証した場合のみ表示する。
 */
async function showAiReviewPreview(results: AiReviewFileResult[]): Promise<void> {
	if (results.every((r) => r.unitResults.length === 0)) {
		return;
	}
	AiReviewResultContentProvider.getInstance().setContent(results);
	await AiReviewResultContentProvider.openPreview();
}
