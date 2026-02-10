/**
 * @file fix-command.ts
 * @description
 *   fixコマンドのエントリーポイント。
 *   ユニット/ファイル/ディレクトリ単位の確定処理を提供する。
 *   withProgressパターンで進捗表示・キャンセル対応。
 * @module commands/fix/fix-command
 */
import * as path from "node:path";
import * as vscode from "vscode";
import { AIServiceBuilder } from "../../api/ai-service-builder";
import { Configuration } from "../../config/configuration";
import { MdaitMarker } from "../../core/markdown/mdait-marker";
import type { MdaitUnit } from "../../core/markdown/mdait-unit";
import { markdownParser } from "../../core/markdown/parser";
import type { StatusItem } from "../../core/status/status-item";
import { StatusManager } from "../../core/status/status-manager";
import { TmxStore } from "../../core/tm/tmx-store";
import { FileExplorer } from "../../utils/file-explorer";
import { Logger, formatError } from "../../utils/logger";
import { ensureMdaitDir } from "../../utils/mdait-dir";
import { SentenceAligner } from "../tm-commit/sentence-aligner";
import { TmCommitProcessor } from "../tm-commit/tm-commit-processor";

const logger = Logger.getInstance();

/** TMXファイル名 */
const TMX_FILENAME = "translations.tmx";

/** fix処理の結果 */
interface FixResult {
	/** 確定されたユニット数 */
	fixedUnits: number;
	/** スキップされたユニット数 */
	skippedUnits: number;
	/** エラーが発生したユニット数 */
	errorUnits: number;
}

/**
 * TMXファイルのパスを取得する。
 * @returns TMXファイルの絶対パス（ワークスペースが見つからない場合はnull）
 */
function getTmxFilePath(): string | null {
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!workspaceRoot) {
		return null;
	}
	return path.join(workspaceRoot, ".mdait", TMX_FILENAME);
}

/**
 * ユニットがfix対象かどうか判定する。
 *
 * 対象条件:
 * - from属性あり（ターゲットファイルのユニット）
 * - need属性なし（翻訳済み）
 * - fixed属性なし（未確定）
 */
function isFixTarget(unit: MdaitUnit): boolean {
	if (!unit.marker?.from) {
		return false;
	}
	if (unit.marker.need) {
		return false;
	}
	if (unit.marker.isFixed()) {
		return false;
	}
	return true;
}

/**
 * ユニット単位のfixコマンド（CodeLensから呼び出し）
 * @param range マーカー行のRange
 */
export async function fixUnitCommand(range?: vscode.Range): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor || !range) {
		return;
	}

	// マーカー行からunitHashを抽出
	const lineText = editor.document.lineAt(range.start.line).text;
	const marker = MdaitMarker.parse(lineText);
	const unitHash = marker?.hash;
	if (!unitHash) {
		vscode.window.showErrorMessage(vscode.l10n.t("Could not extract unit hash from marker."));
		return;
	}

	const config = Configuration.getInstance();

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: vscode.l10n.t("Fix"),
			cancellable: true,
		},
		async (progress, token) => {
			try {
				progress.report({ message: vscode.l10n.t("Initializing...") });

				const filePath = editor.document.uri.fsPath;
				const content = editor.document.getText();
				const markdown = markdownParser.parse(content, config);

				// unitHashでユニットを検索（行番号ベースではなくハッシュベース）
				const targetUnit = markdown.units.find((u) => u.marker?.hash === unitHash);

				if (!targetUnit) {
					vscode.window.showErrorMessage(vscode.l10n.t("Unit not found"));
					return;
				}

				if (!isFixTarget(targetUnit)) {
					if (targetUnit.marker?.isFixed()) {
						vscode.window.showInformationMessage(vscode.l10n.t("This unit is already fixed."));
					} else {
						vscode.window.showInformationMessage(vscode.l10n.t("This unit is not eligible for fix."));
					}
					return;
				}

				// マーカーにfixedフラグを設定
				if (!targetUnit.marker) {
					return;
				}
				targetUnit.marker.setFixed(true);

				// ファイルに書き込み（マーカー行を置換）
				await writeMarkerToFile(editor.document, targetUnit, range.start.line);

				// TM登録処理
				const shouldCommitTm = config.getTmEnabled() && config.getFixTmEnabled();
				if (shouldCommitTm) {
					progress.report({ message: vscode.l10n.t("Registering to TM...") });
					try {
						await executeTmCommitForUnits([targetUnit], filePath, config, progress, token);
					} catch (error) {
						logger.warn("fix", "TM commit error", formatError(error));
						// TM登録エラーは警告だけ出して続行
						vscode.window.showWarningMessage(vscode.l10n.t("Fix completed but TM commit failed: {0}", (error as Error).message));
						return;
					}
				}

				vscode.window.showInformationMessage(vscode.l10n.t("Fix completed: {0}", path.basename(filePath)));
			} catch (error) {
				vscode.window.showErrorMessage(vscode.l10n.t("Fix error: {0}", (error as Error).message));
			}
		},
	);
}

/**
 * ファイル単位のfixコマンド（StatusTreeから呼び出し）
 * @param item StatusItem
 */
export async function fixFileCommand(item?: StatusItem): Promise<void> {
	if (!item || !("filePath" in item)) {
		vscode.window.showErrorMessage(vscode.l10n.t("Invalid file item"));
		return;
	}

	const config = Configuration.getInstance();
	const filePath = (item as { filePath: string }).filePath;

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: vscode.l10n.t("Fix: {0}", path.basename(filePath)),
			cancellable: true,
		},
		async (progress, token) => {
			try {
				const result = await executeFixForFile(filePath, config, progress, token);
				showFixResult(result);
			} catch (error) {
				vscode.window.showErrorMessage(vscode.l10n.t("Fix error: {0}", (error as Error).message));
			}
		},
	);
}

/**
 * ディレクトリ単位のfixコマンド（StatusTreeから呼び出し）
 * @param item StatusItem
 */
export async function fixDirectoryCommand(item?: StatusItem): Promise<void> {
	if (!item || !("dirPath" in item)) {
		vscode.window.showErrorMessage(vscode.l10n.t("Invalid directory item"));
		return;
	}

	const config = Configuration.getInstance();
	const dirPath = (item as { dirPath: string }).dirPath;

	const confirm = await vscode.window.showInformationMessage(
		vscode.l10n.t("Fix all files in directory '{0}'?", path.basename(dirPath)),
		vscode.l10n.t("Yes"),
		vscode.l10n.t("No"),
	);
	if (confirm !== vscode.l10n.t("Yes")) {
		return;
	}

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: vscode.l10n.t("Fix: {0}", path.basename(dirPath)),
			cancellable: true,
		},
		async (progress, token) => {
			try {
				const fileExplorer = new FileExplorer();
				const files = await fileExplorer.findFilesInDirectory(dirPath, [".md"], "**/*.md", config.ignoredPatterns);

				const overallResult: FixResult = {
					fixedUnits: 0,
					skippedUnits: 0,
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
						const result = await executeFixForFile(files[i], config, progress, token);
						overallResult.fixedUnits += result.fixedUnits;
						overallResult.skippedUnits += result.skippedUnits;
						overallResult.errorUnits += result.errorUnits;
					} catch (error) {
						logger.warn("fix", "File processing error", {
							file: files[i],
							...formatError(error),
						});
						overallResult.errorUnits++;
					}
				}

				showFixResult(overallResult);
			} catch (error) {
				vscode.window.showErrorMessage(vscode.l10n.t("Fix error: {0}", (error as Error).message));
			}
		},
	);
}

/**
 * ファイル内の全対象ユニットにfixを実行する。
 */
async function executeFixForFile(
	filePath: string,
	config: Configuration,
	progress: vscode.Progress<{ message?: string; increment?: number }>,
	token: vscode.CancellationToken,
): Promise<FixResult> {
	const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
	const content = document.getText();
	const markdown = markdownParser.parse(content, config);
	const targetUnits = markdown.units.filter(isFixTarget);

	if (targetUnits.length === 0) {
		return {
			fixedUnits: 0,
			skippedUnits: markdown.units.length,
			errorUnits: 0,
		};
	}

	const result: FixResult = {
		fixedUnits: 0,
		skippedUnits: 0,
		errorUnits: 0,
	};

	// マーカーにfixedフラグを設定
	for (const unit of targetUnits) {
		if (!unit.marker) {
			result.skippedUnits++;
			continue;
		}
		unit.marker.setFixed(true);
		result.fixedUnits++;
	}

	// ファイル全体を書き換え
	await writeMarkdownToFile(document, markdown);

	// TM登録処理
	const shouldCommitTm = config.getTmEnabled() && config.getFixTmEnabled();
	if (shouldCommitTm && targetUnits.length > 0) {
		try {
			await executeTmCommitForUnits(targetUnits, filePath, config, progress, token);
		} catch (error) {
			logger.warn("fix", "TM commit error for file", {
				file: filePath,
				...formatError(error),
			});
			// TM登録エラーは警告だけ出して続行
		}
	}

	logger.info("fix", "Fix completed for file", {
		file: filePath,
		fixedUnits: result.fixedUnits,
		skippedUnits: result.skippedUnits,
	});

	return result;
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
): Promise<void> {
	const statusManager = StatusManager.getInstance();
	const fileExplorer = new FileExplorer();
	const transPair = fileExplorer.getTransPairFromTarget(filePath, config);

	if (!transPair) {
		throw new Error(vscode.l10n.t("No translation pair found for file: {0}", filePath));
	}

	// TMXストアの初期化
	const tmxFilePath = getTmxFilePath();
	if (!tmxFilePath) {
		throw new Error("Workspace not found");
	}
	await ensureMdaitDir();
	const store = TmxStore.getInstance(tmxFilePath);

	// AIServiceとSentenceAlignerの構築
	const aiService = await new AIServiceBuilder().build();
	const aligner = new SentenceAligner(aiService);
	const processor = new TmCommitProcessor(store, aligner, transPair.sourceLang, transPair.targetLang);

	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
	const relativePath = path.relative(workspaceRoot, filePath).replace(/\\/g, "/");

	for (let i = 0; i < units.length; i++) {
		if (token.isCancellationRequested) {
			logger.info("fix-tm", "TM commit cancelled");
			break;
		}

		const unit = units[i];

		if (!unit.marker?.from) {
			continue;
		}

		try {
			// ソースユニットの内容を取得
			const sourceContent = await getSourceContent(unit, statusManager, config);
			if (!sourceContent) {
				continue;
			}

			await processor.processUnit(sourceContent, unit.content, relativePath, token);
		} catch (error) {
			logger.warn("fix-tm", "Unit processing error", {
				unitHash: unit.marker?.hash,
				...formatError(error),
			});
		}
	}

	// 永続化
	store.save(tmxFilePath);

	logger.info("fix-tm", "TM commit completed", {
		file: relativePath,
		processedUnits: units.length,
	});
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
		logger.warn("fix", "Failed to read source unit", {
			filePath: sourceUnit.filePath,
			...formatError(error),
		});
		return null;
	}
}

/**
 * マーカー行をファイルに書き込む（単一ユニット用）。
 */
async function writeMarkerToFile(
	document: vscode.TextDocument,
	unit: MdaitUnit,
	lineNumber: number,
): Promise<void> {
	if (!unit.marker) {
		return;
	}

	const newMarkerText = unit.marker.toString();
	const edit = new vscode.WorkspaceEdit();
	const line = document.lineAt(lineNumber);
	edit.replace(document.uri, line.range, newMarkerText);
	await vscode.workspace.applyEdit(edit);
	await document.save();
}

/**
 * マークダウン全体をファイルに書き込む（複数ユニット用）。
 */
async function writeMarkdownToFile(
	document: vscode.TextDocument,
	markdown: ReturnType<typeof markdownParser.parse>,
): Promise<void> {
	// 元のテキストを取得
	const originalText = document.getText();
	const lines = originalText.split("\n");

	// 各ユニットのマーカー行を更新
	for (const unit of markdown.units) {
		if (!unit.marker || unit.startLine === undefined) {
			continue;
		}

		const newMarkerText = unit.marker.toString();
		lines[unit.startLine] = newMarkerText;
	}

	// ファイル全体を書き換え
	const newText = lines.join("\n");
	const edit = new vscode.WorkspaceEdit();
	const fullRange = new vscode.Range(
		document.positionAt(0),
		document.positionAt(originalText.length),
	);
	edit.replace(document.uri, fullRange, newText);
	await vscode.workspace.applyEdit(edit);
	await document.save();
}

/**
 * fix結果を通知表示する。
 */
function showFixResult(result: FixResult): void {
	const message = vscode.l10n.t(
		"Fix completed: {0} fixed, {1} skipped, {2} errors",
		result.fixedUnits,
		result.skippedUnits,
		result.errorUnits,
	);
	if (result.errorUnits > 0) {
		vscode.window.showWarningMessage(message);
	} else {
		vscode.window.showInformationMessage(message);
	}
}
