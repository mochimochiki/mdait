/**
 * @file command-commit.ts
 * @description
 *   tm-commitコマンドのエントリーポイント。
 *   ファイル/ディレクトリ単位のTM登録を提供する。
 *   withProgressパターンで進捗表示・キャンセル対応。
 *   TMXのsourceHashによるスキップ判定でバッチ効率を最適化。
 * @module commands/tm/command-commit
 */
import * as path from "node:path";
import * as vscode from "vscode";
import { Configuration } from "../../config/configuration";
import type { MdaitUnit } from "../../core/markdown/mdait-unit";
import { markdownParser } from "../../core/markdown/parser";
import { Status, type StatusItem } from "../../core/status/status-item";
import { StatusManager } from "../../core/status/status-manager";
import { TmxStore } from "../../core/tm/tmx-store";
import { AIServiceBuilder } from "../../llm/ai-service-builder";
import { AIOnboarding } from "../../utils/ai-onboarding";
import { FileExplorer } from "../../utils/file-explorer";
import { Logger, formatError } from "../../utils/logger";
import { ensureMdaitDir } from "../../utils/mdait-dir";
import { isTmCommitTarget } from "./commit-filter";
import { TmCommitProcessor, type TmCommitResult } from "./commit-processor";
import { SentenceAligner } from "./sentence-aligner";

const logger = Logger.getInstance();

/**
 * ファイル単位のtm-commitコマンド（StatusTreeから呼び出し）
 * @param item StatusItem
 */
export async function tmCommitFileCommand(item?: StatusItem): Promise<void> {
	if (!item || !("filePath" in item)) {
		vscode.window.showErrorMessage(vscode.l10n.t("Invalid file item"));
		return;
	}

	const config = Configuration.getInstance();
	if (!config.getTmEnabled()) {
		vscode.window.showInformationMessage(vscode.l10n.t("TM feature is disabled. Enable it in mdait.json."));
		return;
	}

	const aiOnboarding = AIOnboarding.getInstance();
	const shouldProceed = await aiOnboarding.checkAndShowFirstUseDialog();
	if (!shouldProceed) {
		return;
	}

	const filePath = (item as { filePath: string }).filePath;

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: vscode.l10n.t("TM Commit: {0}", path.basename(filePath)),
			cancellable: true,
		},
		async (progress, token) => {
			try {
				await executeTmCommitForFile(filePath, config, progress, token);
			} catch (error) {
				vscode.window.showErrorMessage(vscode.l10n.t("TM commit error: {0}", (error as Error).message));
			}
		},
	);
}

/**
 * ディレクトリ単位のtm-commitコマンド（StatusTreeから呼び出し）
 * @param item StatusItem
 */
export async function tmCommitDirectoryCommand(item?: StatusItem): Promise<void> {
	if (!item || !("dirPath" in item)) {
		vscode.window.showErrorMessage(vscode.l10n.t("Invalid directory item"));
		return;
	}

	const config = Configuration.getInstance();
	if (!config.getTmEnabled()) {
		vscode.window.showInformationMessage(vscode.l10n.t("TM feature is disabled. Enable it in mdait.json."));
		return;
	}

	const aiOnboarding = AIOnboarding.getInstance();
	const shouldProceed = await aiOnboarding.checkAndShowFirstUseDialog();
	if (!shouldProceed) {
		return;
	}

	const dirPath = (item as { dirPath: string }).dirPath;

	const confirm = await vscode.window.showInformationMessage(
		vscode.l10n.t("Register TM for all files in directory '{0}'?", path.basename(dirPath)),
		vscode.l10n.t("Yes"),
		vscode.l10n.t("No"),
	);
	if (confirm !== vscode.l10n.t("Yes")) {
		return;
	}

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: vscode.l10n.t("TM Commit: {0}", path.basename(dirPath)),
			cancellable: true,
		},
		async (progress, token) => {
			try {
				const fileExplorer = new FileExplorer();
				const files = await fileExplorer.findFilesInDirectory(dirPath, [".md"], "**/*.md", config.ignoredPatterns);

				const overallResult: TmCommitResult = {
					processedUnits: 0,
					skippedUnits: 0,
					newEntries: 0,
					existingEntries: 0,
					errorUnits: 0,
				};

				for (let i = 0; i < files.length; i++) {
					if (token.isCancellationRequested) {
						break;
					}

					progress.report({
						message: vscode.l10n.t("{0}/{1} files", i + 1, files.length),
						increment: 100 / files.length,
					});

					try {
						const result = await executeTmCommitForFile(files[i], config, progress, token);
						overallResult.processedUnits += result.processedUnits;
						overallResult.skippedUnits += result.skippedUnits;
						overallResult.newEntries += result.newEntries;
						overallResult.existingEntries += result.existingEntries;
						overallResult.errorUnits += result.errorUnits;
					} catch (error) {
						logger.warn("tm.commit", "File processing error", {
							file: files[i],
							...formatError(error),
						});
						overallResult.errorUnits++;
					}
				}

				showTmCommitResult(overallResult);
			} catch (error) {
				vscode.window.showErrorMessage(vscode.l10n.t("TM commit error: {0}", (error as Error).message));
			}
		},
	);
}

/**
 * ファイル内の全対象ユニットにtm-commitを実行する。
 */
async function executeTmCommitForFile(
	filePath: string,
	config: Configuration,
	progress: vscode.Progress<{ message?: string; increment?: number }>,
	token: vscode.CancellationToken,
): Promise<TmCommitResult> {
	const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
	const content = document.getText();
	const markdown = markdownParser.parse(content, config);
	const targetUnits = markdown.units.filter(isTmCommitTarget);

	if (targetUnits.length === 0) {
		return {
			processedUnits: 0,
			skippedUnits: markdown.units.length,
			newEntries: 0,
			existingEntries: 0,
			errorUnits: 0,
		};
	}

	return executeTmCommitForUnits(targetUnits, filePath, config, progress, token);
}

/**
 * 指定ユニット群にtm-commitを実行する。
 */
async function executeTmCommitForUnits(
	units: MdaitUnit[],
	filePath: string,
	config: Configuration,
	progress: vscode.Progress<{ message?: string; increment?: number }>,
	token: vscode.CancellationToken,
): Promise<TmCommitResult> {
	const statusManager = StatusManager.getInstance();
	const fileExplorer = new FileExplorer();
	const transPair = fileExplorer.getTransPairFromTarget(filePath, config);

	if (!transPair) {
		throw new Error(vscode.l10n.t("No translation pair found for file: {0}", filePath));
	}

	// TMXストアの初期化
	const tmxFilePath = config.getTmFilePath();
	await ensureMdaitDir();
	const store = TmxStore.getInstance(tmxFilePath);

	// AIServiceとSentenceAlignerの構築
	const aiService = await new AIServiceBuilder().build();
	const aligner = new SentenceAligner(aiService);
	const processor = new TmCommitProcessor(store, aligner, transPair.sourceLang, transPair.targetLang);

	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
	const relativePath = path.relative(workspaceRoot, filePath).replace(/\\/g, "/");

	const result: TmCommitResult = {
		processedUnits: 0,
		skippedUnits: 0,
		newEntries: 0,
		existingEntries: 0,
		errorUnits: 0,
	};

	for (let i = 0; i < units.length; i++) {
		if (token.isCancellationRequested) {
			logger.info("tm.commit", "TM commit cancelled");
			break;
		}

		const unit = units[i];
		progress.report({
			message: vscode.l10n.t("{0}/{1} units", i + 1, units.length),
		});

		if (!unit.marker?.from) {
			result.skippedUnits++;
			continue;
		}

		// sourceHashベーススキップ: 原文が変わっていなければスキップ
		if (unit.marker.hash && store.hasSourceHash(unit.marker.hash)) {
			result.skippedUnits++;
			continue;
		}

		try {
			// ソースユニットの内容を取得
			const sourceContent = await getSourceContent(unit, statusManager, config);
			if (!sourceContent) {
				result.skippedUnits++;
				continue;
			}

			const unitResult = await processor.processUnit(
				sourceContent,
				unit.content,
				relativePath,
				token,
				unit.marker.hash,
			);

			result.processedUnits++;
			result.newEntries += unitResult.newCount;
			result.existingEntries += unitResult.existingCount;
		} catch (error) {
			logger.warn("tm.commit", "Unit processing error", {
				unitHash: unit.marker?.hash,
				...formatError(error),
			});
			result.errorUnits++;
		}
	}

	// 永続化
	store.save(tmxFilePath);

	logger.info("tm.commit", "TM commit completed", {
		file: relativePath,
		processedUnits: result.processedUnits,
		newEntries: result.newEntries,
		existingEntries: result.existingEntries,
		errorUnits: result.errorUnits,
	});

	return result;
}

/**
 * ユニットのfrom属性からソースコンテンツを取得する。
 */
async function getSourceContent(
	unit: MdaitUnit,
	statusManager: StatusManager,
	config: Configuration,
): Promise<string | null> {
	if (!unit.marker?.from) {
		return null;
	}

	const tree = statusManager.getStatusItemTree();
	const sourceUnit = tree.getUnitByHash(unit.marker.from);
	if (!sourceUnit?.filePath) {
		return null;
	}

	try {
		const sourceUri = vscode.Uri.file(sourceUnit.filePath);
		const sourceDoc = await vscode.workspace.openTextDocument(sourceUri);
		const sourceFileContent = sourceDoc.getText();
		const sourceMarkdown = markdownParser.parse(sourceFileContent, config);
		const sourceUnitData = sourceMarkdown.units.find((u) => u.marker?.hash === sourceUnit.unitHash);
		return sourceUnitData?.content ?? null;
	} catch (error) {
		logger.warn("tm.commit", "Failed to read source unit", {
			filePath: sourceUnit.filePath,
			...formatError(error),
		});
		return null;
	}
}

/**
 * TM commit結果を通知表示する。
 */
function showTmCommitResult(result: TmCommitResult): void {
	const message = vscode.l10n.t(
		"TM commit completed: {0} new, {1} updated, {2} errors",
		result.newEntries,
		result.existingEntries,
		result.errorUnits,
	);
	if (result.errorUnits > 0) {
		vscode.window.showWarningMessage(message);
	} else {
		vscode.window.showInformationMessage(message);
	}
}
