/**
 * @file command-commit.ts
 * @description
 *   tm-commitコマンドのエントリーポイント。
 *   ファイル/ディレクトリ単位のTM登録を提供する。
 *   withProgressパターンで進捗表示・キャンセル対応。
 * @module commands/tm/command-commit
 */
import * as path from "node:path";
import * as vscode from "vscode";
import type { MdaitUnit } from "../../core/markdown/mdait-unit";
import { markdownParser } from "../../core/markdown/parser";
import type { StatusItem, UnitStatusItem } from "../../core/status/status-item";
import { StatusManager } from "../../core/status/status-manager";
import { TmxStore } from "../../core/tm/tmx-store";
import { Configuration } from "../../infra/config/configuration";
import { AIServiceBuilder } from "../../infra/llm/ai-service-builder";
import { Logger, formatError } from "../../infra/logging/logger";
import { AIOnboarding } from "../../infra/onboarding/ai-onboarding";
import { FileExplorer } from "../../infra/workspace/file-explorer";
import { ensureMdaitDir } from "../../infra/workspace/mdait-dir";
import { PromptProvider } from "../../prompts";
import { isTmCommitTarget, summarizeTmSkipReasons } from "./commit-filter";
import type { TmSkipReasonBreakdown } from "./commit-filter";
import {
	TmCommitProcessor,
	type TmCommitResolvedUnit,
	type TmCommitResult,
} from "./commit-processor";
import {
	type PreparedTmCommitUnit,
	type TmCommitResolutionResult,
	buildTmCommitUnitResolution,
	prepareTmCommitUnit,
} from "./tm-commit-unit-resolution";
import { LLMTmEntryGenerator } from "./tm-entry-generator";
import { TmResultContentProvider } from "./tm-result-provider";

export {
	buildTmCommitUnitResolution,
	prepareTmCommitUnit,
} from "./tm-commit-unit-resolution";
export type {
	TmCommitResolutionResult,
	PreparedTmCommitUnit,
} from "./tm-commit-unit-resolution";

const logger = Logger.getInstance();

/**
 * ファイル単位のtm-commitコマンド（StatusTreeから呼び出し）
 * @param item StatusItem
 */
export async function tmCommitFileCommand(
	item?: StatusItem,
): Promise<TmCommitResult | undefined> {
	if (!item || !("filePath" in item)) {
		vscode.window.showErrorMessage(vscode.l10n.t("Invalid file item"));
		return;
	}

	const config = Configuration.getInstance();
	const validationError = config.validate();
	if (validationError) {
		vscode.window.showErrorMessage(validationError);
		return;
	}
	if (!config.getTmEnabled()) {
		vscode.window.showInformationMessage(
			vscode.l10n.t("TM feature is disabled. Enable it in mdait.json."),
		);
		return;
	}

	const aiOnboarding = AIOnboarding.getInstance();
	const shouldProceed = await aiOnboarding.checkAndShowFirstUseDialog();
	if (!shouldProceed) {
		return;
	}

	const filePath = (item as { filePath: string }).filePath;

	return await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: vscode.l10n.t("TM Commit: {0}", path.basename(filePath)),
			cancellable: true,
		},
		async (progress, token) => {
			try {
				const result = await executeTmCommitForFile(
					filePath,
					config,
					progress,
					token,
				);
				showTmCommitResult(result);
				await showTmCommitPreview(result);
				return result;
			} catch (error) {
				logger.error("tm.commit", "TM commit failed", {
					file: path.basename(filePath),
					...formatError(error),
				});
				vscode.window.showErrorMessage(
					vscode.l10n.t("TM commit error: {0}", (error as Error).message),
				);
				return undefined;
			}
		},
	);
}

/**
 * ディレクトリ単位のtm-commitコマンド（StatusTreeから呼び出し）
 * @param item StatusItem
 */
export async function tmCommitDirectoryCommand(
	item?: StatusItem,
): Promise<TmCommitResult | undefined> {
	// directoryPath が正（StatusTree・debug IPC とも）。dirPath は後方互換のみ
	const dirPath =
		item && "directoryPath" in item
			? (item as { directoryPath: string }).directoryPath
			: item && "dirPath" in item
				? (item as { dirPath: string }).dirPath
				: undefined;
	if (!dirPath) {
		vscode.window.showErrorMessage(vscode.l10n.t("Invalid directory item"));
		return;
	}

	const config = Configuration.getInstance();
	const validationError = config.validate();
	if (validationError) {
		vscode.window.showErrorMessage(validationError);
		return;
	}
	if (!config.getTmEnabled()) {
		vscode.window.showInformationMessage(
			vscode.l10n.t("TM feature is disabled. Enable it in mdait.json."),
		);
		return;
	}

	const aiOnboarding = AIOnboarding.getInstance();
	const shouldProceed = await aiOnboarding.checkAndShowFirstUseDialog();
	if (!shouldProceed) {
		return;
	}

	const confirm = await vscode.window.showInformationMessage(
		vscode.l10n.t(
			"Register TM for all files in directory '{0}'?",
			path.basename(dirPath),
		),
		vscode.l10n.t("Yes"),
		vscode.l10n.t("No"),
	);
	if (confirm !== vscode.l10n.t("Yes")) {
		return;
	}

	return await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: vscode.l10n.t("TM Commit: {0}", path.basename(dirPath)),
			cancellable: true,
		},
		async (progress, token) => {
			try {
				const fileExplorer = new FileExplorer();
				const files = await fileExplorer.findFilesInDirectory(
					dirPath,
					[".md"],
					"**/*.md",
					config.ignoredPatterns,
				);

				const overallResult: TmCommitResult = {
					processedUnits: 0,
					skippedUnits: 0,
					newEntries: 0,
					existingEntries: 0,
					warnedEntries: 0,
					errorUnits: 0,
					newItems: [],
					updatedItems: [],
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
						const result = await executeTmCommitForFile(
							files[i],
							config,
							progress,
							token,
						);
						overallResult.processedUnits += result.processedUnits;
						overallResult.skippedUnits += result.skippedUnits;
						overallResult.newEntries += result.newEntries;
						overallResult.existingEntries += result.existingEntries;
						overallResult.warnedEntries += result.warnedEntries;
						overallResult.errorUnits += result.errorUnits;
						overallResult.newItems.push(...result.newItems);
						overallResult.updatedItems.push(...result.updatedItems);
					} catch (error) {
						logger.warn("tm.commit", "File processing error", {
							file: files[i],
							...formatError(error),
						});
						overallResult.errorUnits++;
					}
				}

				showTmCommitResult(overallResult);
				await showTmCommitPreview(overallResult);
				return overallResult;
			} catch (error) {
				vscode.window.showErrorMessage(
					vscode.l10n.t("TM commit error: {0}", (error as Error).message),
				);
				return undefined;
			}
		},
	);
}

/**
 * ファイル内の全対象ユニットにtm-commitを実行する。
 * lm-tools（mdait_tm）からも再利用される。
 */
export async function executeTmCommitForFile(
	filePath: string,
	config: Configuration,
	progress: vscode.Progress<{ message?: string; increment?: number }>,
	token: vscode.CancellationToken,
): Promise<TmCommitResult> {
	const document = await vscode.workspace.openTextDocument(
		vscode.Uri.file(filePath),
	);
	const content = document.getText();
	const markdown = markdownParser.parse(content, config);
	const targetUnits = markdown.units.filter(isTmCommitTarget);
	const skipReasons = summarizeTmSkipReasons(markdown.units);

	if (targetUnits.length === 0) {
		logger.debug("tm.commit", "No commit target units found", {
			file: path.basename(filePath),
			totalUnits: markdown.units.length,
		});
		return {
			processedUnits: 0,
			skippedUnits: markdown.units.length,
			newEntries: 0,
			existingEntries: 0,
			warnedEntries: 0,
			errorUnits: 0,
			newItems: [],
			updatedItems: [],
			skipReasons,
		};
	}

	const result = await executeTmCommitForUnits(
		targetUnits,
		filePath,
		config,
		progress,
		token,
		skipReasons,
	);
	result.skipReasons = skipReasons;
	result.skippedUnits += markdown.units.length - targetUnits.length;
	return result;
}

/**
 * 指定ユニット群にtm-commitを実行する。
 * @param skipReasons ペア解決時の sourcePending スキップを加算する内訳（省略可）
 */
async function executeTmCommitForUnits(
	units: MdaitUnit[],
	filePath: string,
	config: Configuration,
	progress: vscode.Progress<{ message?: string; increment?: number }>,
	token: vscode.CancellationToken,
	skipReasons?: TmSkipReasonBreakdown,
): Promise<TmCommitResult> {
	const statusManager = StatusManager.getInstance();
	const fileExplorer = new FileExplorer();
	const transPair = fileExplorer.getTransPairFromTarget(filePath, config);

	if (!transPair) {
		throw new Error(
			vscode.l10n.t("No translation pair found for file: {0}", filePath),
		);
	}

	// TMXストアの初期化
	const tmxFilePath = config.getTmFilePath();
	await ensureMdaitDir();
	const store = TmxStore.getInstance(tmxFilePath);

	// AIServiceとLLMTmEntryGeneratorの構築
	const aiService = await new AIServiceBuilder().build();
	const promptProvider = PromptProvider.getInstance();
	const generator = new LLMTmEntryGenerator(aiService, (id, variables) =>
		promptProvider.getPrompt(id, variables),
	);
	const processor = new TmCommitProcessor(
		store,
		generator,
		config.getTermsPrimaryLang(),
		config.getTmRetryLimit(),
	);

	const workspaceRoot =
		vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
	const relativePath = path
		.relative(workspaceRoot, filePath)
		.replace(/\\/g, "/");

	const result: TmCommitResult = {
		processedUnits: 0,
		skippedUnits: 0,
		newEntries: 0,
		existingEntries: 0,
		warnedEntries: 0,
		errorUnits: 0,
		newItems: [],
		updatedItems: [],
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

		try {
			// source 側ユニットに need が付いている場合はペアが確定していない（isolate 凍結・
			// review プレースホルダ等）ため、TM汚染防止としてスキップし sourcePending に集計する
			let sourcePending = false;
			const preparedUnit = await prepareTmCommitUnit(unit, async () => {
				const outcome = await resolveTmCommitUnits(
					unit,
					filePath,
					transPair.targetLang,
					statusManager,
					config,
					fileExplorer,
				);
				sourcePending = outcome.sourcePending;
				return outcome.resolution;
			});
			if (preparedUnit.shouldSkip) {
				result.skippedUnits++;
				continue;
			}

			if (sourcePending) {
				result.skippedUnits++;
				if (skipReasons) {
					skipReasons.sourcePending++;
				}
				continue;
			}

			if (!preparedUnit.resolution) {
				result.skippedUnits++;
				result.warnedEntries++;
				continue;
			}

			const unitResult = await processor.processUnit(
				preparedUnit.resolution.primaryUnit,
				preparedUnit.resolution.localUnit,
				token,
			);

			result.processedUnits++;
			result.newEntries += unitResult.newCount;
			result.existingEntries += unitResult.existingCount;
			result.warnedEntries += unitResult.warnedCount;
			result.newItems.push(...unitResult.newItems);
			result.updatedItems.push(...unitResult.updatedItems);
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
		warnedEntries: result.warnedEntries,
		errorUnits: result.errorUnits,
	});

	return result;
}

/** ペア解決の結果。sourcePending は source 側ユニットに need が付いていたことを表す */
interface TmCommitResolutionOutcome {
	resolution: TmCommitResolutionResult | null;
	sourcePending: boolean;
}

/**
 * tm-commit 用に primaryUnit / localUnit を解決する。
 */
async function resolveTmCommitUnits(
	unit: MdaitUnit,
	filePath: string,
	currentLang: string,
	statusManager: StatusManager,
	config: Configuration,
	fileExplorer: FileExplorer,
): Promise<TmCommitResolutionOutcome> {
	const currentUnit: TmCommitResolvedUnit = {
		content: unit.content,
		lang: currentLang,
		unitPath: normalizeWorkspaceRelativePath(filePath),
		unitHash: unit.marker?.hash ?? "",
	};

	if (!unit.marker?.from || !currentUnit.unitHash) {
		return { resolution: null, sourcePending: false };
	}

	const tree = statusManager.getStatusItemTree();
	const sourceStatus = getSourceStatusUnit(
		unit.marker.from,
		filePath,
		tree,
		config,
		fileExplorer,
	);
	if (!sourceStatus) {
		logger.warn("tm.commit", "Failed to resolve direct source unit", {
			filePath: currentUnit.unitPath,
			fromHash: unit.marker.from,
		});
		return { resolution: null, sourcePending: false };
	}

	// source 側に need が付いたペアは未確定（isolate 凍結・レガシー review プレースホルダ等）。
	// ドリフトした対訳の TM 汚染を防ぐためスキップ対象として返す
	if (sourceStatus.needFlag) {
		logger.info("tm.commit", "Skipped: source unit has a pending need flag", {
			filePath: currentUnit.unitPath,
			fromHash: unit.marker.from,
			sourceNeed: sourceStatus.needFlag,
		});
		return { resolution: null, sourcePending: true };
	}

	const sourceUnit = await readResolvedUnit(
		sourceStatus,
		statusManager,
		config,
		fileExplorer,
	);
	if (!sourceUnit) {
		return { resolution: null, sourcePending: false };
	}

	const resolution = await buildTmCommitUnitResolution(
		currentUnit,
		sourceUnit,
		config.getTermsPrimaryLang(),
		async (candidate) =>
			await resolvePrimaryAncestor(
				candidate,
				statusManager,
				config,
				fileExplorer,
			),
	);

	if (!resolution) {
		logger.warn("tm.commit", "Failed to resolve primary unit", {
			filePath: currentUnit.unitPath,
			unitHash: currentUnit.unitHash,
			localLang: currentLang,
		});
	}

	return { resolution, sourcePending: false };
}

async function resolvePrimaryAncestor(
	unit: TmCommitResolvedUnit,
	statusManager: StatusManager,
	config: Configuration,
	fileExplorer: FileExplorer,
	visited = new Set<string>(),
): Promise<TmCommitResolvedUnit | null> {
	const visitKey = `${unit.unitPath}#${unit.unitHash}`;
	if (visited.has(visitKey)) {
		logger.warn("tm.commit", "Detected cyclic primary ancestor chain", {
			filePath: unit.unitPath,
			unitHash: unit.unitHash,
			lang: unit.lang,
		});
		return null;
	}
	const nextVisited = new Set(visited);
	nextVisited.add(visitKey);

	if (unit.lang === config.getTermsPrimaryLang()) {
		return unit;
	}

	const tree = statusManager.getStatusItemTree();
	const currentStatus = tree.getUnit(
		unit.unitHash,
		denormalizeWorkspaceRelativePath(unit.unitPath),
	);
	if (!currentStatus?.fromHash) {
		return null;
	}

	const sourceStatus = getSourceStatusUnit(
		currentStatus.fromHash,
		currentStatus.filePath,
		tree,
		config,
		fileExplorer,
	);
	if (!sourceStatus) {
		return null;
	}

	const sourceUnit = await readResolvedUnit(
		sourceStatus,
		statusManager,
		config,
		fileExplorer,
	);
	if (!sourceUnit) {
		return null;
	}

	if (sourceUnit.lang === config.getTermsPrimaryLang()) {
		return sourceUnit;
	}

	return resolvePrimaryAncestor(
		sourceUnit,
		statusManager,
		config,
		fileExplorer,
		nextVisited,
	);
}

function getSourceStatusUnit(
	fromHash: string,
	filePath: string,
	tree: ReturnType<StatusManager["getStatusItemTree"]>,
	config: Configuration,
	fileExplorer: FileExplorer,
): UnitStatusItem | undefined {
	const transPair = fileExplorer.getTransPairFromTarget(filePath, config);
	const preferredSourcePath = transPair
		? fileExplorer.getSourcePath(filePath, transPair)
		: null;
	return preferredSourcePath
		? (tree.getUnit(fromHash, preferredSourcePath) ??
				tree.getUnitByHash(fromHash))
		: tree.getUnitByHash(fromHash);
}

async function readResolvedUnit(
	statusUnit: UnitStatusItem,
	statusManager: StatusManager,
	config: Configuration,
	fileExplorer: FileExplorer,
): Promise<TmCommitResolvedUnit | null> {
	try {
		const sourceUri = vscode.Uri.file(statusUnit.filePath);
		const sourceDoc = await vscode.workspace.openTextDocument(sourceUri);
		const sourceFileContent = sourceDoc.getText();
		const sourceMarkdown = markdownParser.parse(sourceFileContent, config);
		const sourceUnitData = sourceMarkdown.units.find(
			(u) => u.marker?.hash === statusUnit.unitHash,
		);
		if (!sourceUnitData?.content) {
			return null;
		}
		const lang = resolveFileLanguage(statusUnit.filePath, config, fileExplorer);
		if (!lang) {
			return null;
		}
		return {
			content: sourceUnitData.content,
			lang,
			unitPath: normalizeWorkspaceRelativePath(statusUnit.filePath),
			unitHash: statusUnit.unitHash,
		};
	} catch (error) {
		logger.warn("tm.commit", "Failed to read source unit", {
			filePath: statusUnit.filePath,
			...formatError(error),
		});
		return null;
	}
}

function resolveFileLanguage(
	filePath: string,
	config: Configuration,
	fileExplorer: FileExplorer,
): string | null {
	const targetPair = fileExplorer.getTransPairFromTarget(filePath, config);
	if (targetPair) {
		return targetPair.targetLang;
	}
	const sourcePairs = fileExplorer.getTransPairsFromSource(filePath, config);
	if (sourcePairs.length > 0) {
		return sourcePairs[0].sourceLang;
	}
	return null;
}

function normalizeWorkspaceRelativePath(filePath: string): string {
	const workspaceRoot =
		vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
	return path.relative(workspaceRoot, filePath).replace(/\\/g, "/");
}

function denormalizeWorkspaceRelativePath(relativePath: string): string {
	const workspaceRoot =
		vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
	return path.join(workspaceRoot, relativePath);
}

/**
 * TM commit結果を通知表示する。
 */
function showTmCommitResult(result: TmCommitResult): void {
	const message = vscode.l10n.t(
		"TM commit completed: {0} new, {1} updated, {2} warnings, {3} errors",
		result.newEntries,
		result.existingEntries,
		result.warnedEntries,
		result.errorUnits,
	);
	if (result.errorUnits > 0 || result.warnedEntries > 0) {
		vscode.window.showWarningMessage(message);
	} else {
		vscode.window.showInformationMessage(message);
	}
}

/**
 * tm-commit 結果のプレビュードキュメントを開く。1 件以上の新規/更新がある場合のみ表示する。
 */
async function showTmCommitPreview(result: TmCommitResult): Promise<void> {
	if (result.newItems.length + result.updatedItems.length === 0) {
		return;
	}
	TmResultContentProvider.getInstance().setContent(result);
	await TmResultContentProvider.openPreview();
}
