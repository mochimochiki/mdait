import * as vscode from "vscode";
import { StatusItemType } from "../../core/status/status-item";
import type { StatusItem } from "../../core/status/status-item";
import { StatusManager } from "../../core/status/status-manager";
import { Configuration } from "../../infra/config/configuration";
import { Logger, formatError } from "../../infra/logging/logger";
import { AIOnboarding } from "../../infra/onboarding/ai-onboarding";
import { FileExplorer } from "../../infra/workspace/file-explorer";
import type { StatusTreeProvider } from "../../ui/status/status-tree-provider";
import { clampConcurrency, runWithConcurrency } from "../shared/concurrency";
import {
	type TransCommandResult,
	type TranslateUnitMetrics,
	transFile_CoreProc,
	transUnitCommand,
} from "./trans-command";

export interface DirectoryTranslationResult {
	totalFiles: number;
	successful: number;
	failed: number;
	skipped: number;
}

const logger = Logger.getInstance();

/**
 * ステータスツリーアイテムの翻訳アクションハンドラ
 */
export class StatusTreeTranslationHandler {
	private statusTreeProvider?: StatusTreeProvider;

	/**
	 * StatusTreeProviderを設定する
	 */
	public setStatusTreeProvider(provider: StatusTreeProvider): void {
		this.statusTreeProvider = provider;
	}

	/**
	 * ディレクトリ内の全ファイルを翻訳する
	 */
	public async translateDirectory(item: StatusItem): Promise<DirectoryTranslationResult | undefined> {
		if (item.type !== StatusItemType.Directory || !item.directoryPath) {
			vscode.window.showErrorMessage(vscode.l10n.t("Invalid directory item"));
			return;
		}

		const directoryPath = item.directoryPath; // 型安全性のためローカル変数に保存

		const confirmation = await vscode.window.showInformationMessage(
			vscode.l10n.t("Translate all files in directory '{0}'?", directoryPath),
			{ modal: true },
			vscode.l10n.t("Yes"),
			vscode.l10n.t("No"),
		);

		if (confirmation !== vscode.l10n.t("Yes")) {
			return;
		}

		// AI初回利用チェック
		const aiOnboarding = AIOnboarding.getInstance();
		const shouldProceed = await aiOnboarding.checkAndShowFirstUseDialog();
		if (!shouldProceed) {
			return; // ユーザーがキャンセルした場合
		}

		const statusManager = StatusManager.getInstance();

		try {
			// ディレクトリ配下の翻訳対象ファイルを取得（.md + trans.extensions）
			const config = Configuration.getInstance();
			const globPattern = FileExplorer.buildExtensionGlob(
				config.trans.extensions,
			);
			const pattern = new vscode.RelativePattern(directoryPath, globPattern);
			const files = await vscode.workspace.findFiles(pattern, config.ignoredPatterns);

			if (files.length === 0) {
				vscode.window.showInformationMessage(
					vscode.l10n.t(
						"No translatable files found in directory '{0}'",
						directoryPath,
					),
				);
				return { totalFiles: 0, successful: 0, failed: 0, skipped: 0 };
			}

			// withProgressで進捗表示とキャンセル機能を統合管理
			return await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: vscode.l10n.t("Translating directory '{0}'", directoryPath),
					cancellable: true,
				},
				async (progress, token) => {
					// ディレクトリの翻訳状態を設定
					await statusManager.changeDirectoryStatus(directoryPath, {
						isTranslating: true,
					});

					try {
						// 各ファイルをtrans.concurrencyの同時実行数で並列翻訳（キャンセルチェック付き）。
						// 異なるファイルペアは独立で、同一ファイルはFileMutexが排他するため競合しない
						let successful = 0;
						let failed = 0;
						let completed = 0;
						const concurrency = clampConcurrency(config.trans.concurrency);

						await runWithConcurrency(
							files,
							concurrency,
							async (file) => {
								try {
									// 内部実装を直接呼び出し（二重のwithProgressを回避）
									await transFile_CoreProc(file, progress, token);
									successful++;
								} catch (error) {
									logger.error("trans", "Error translating file", {
										file: file.fsPath,
										...formatError(error),
									});
									failed++;
								}
								completed++;
								progress.report({
									message: vscode.l10n.t("{0}/{1} files", completed, files.length),
									increment: 100 / files.length,
								});
							},
							() => token.isCancellationRequested,
						);

						// キャンセル時は未着手ファイル数を報告
						if (token.isCancellationRequested) {
							logger.info(
								"trans",
								"Directory translation cancelled, skipping remaining files",
							);
							const skipped = files.length - successful - failed;
							vscode.window.showInformationMessage(
								vscode.l10n.t(
									"Directory translation cancelled: {0} files succeeded, {1} files failed, {2} files skipped",
									successful,
									failed,
									skipped,
								),
							);
							return { totalFiles: files.length, successful, failed, skipped };
						}

						// 結果を通知
						if (failed > 0) {
							vscode.window.showWarningMessage(
								vscode.l10n.t(
									"Directory translation completed: {0} files succeeded, {1} files failed",
									successful,
									failed,
								),
							);
						}
						return { totalFiles: files.length, successful, failed, skipped: 0 };
					} finally {
						// ディレクトリの翻訳状態をクリア
						await statusManager.changeDirectoryStatus(directoryPath, {
							isTranslating: false,
						});
					}
				},
			);
		} catch (error) {
			logger.error("trans", "Error during directory translation", formatError(error));
			vscode.window.showErrorMessage(
				vscode.l10n.t(
					"Error during directory translation: {0}",
					(error as Error).message,
				),
			);
			return undefined;
		}
	}

	/**
	 * 単一ファイルを翻訳する
	 */
	public async translateFile(
		item: StatusItem,
	): Promise<TransCommandResult | undefined> {
		if (item.type !== StatusItemType.File || !item.filePath) {
			vscode.window.showErrorMessage(vscode.l10n.t("Invalid file item"));
			return;
		}

		// AI初回利用チェック
		const aiOnboarding = AIOnboarding.getInstance();
		const shouldProceed = await aiOnboarding.checkAndShowFirstUseDialog();
		if (!shouldProceed) {
			return; // ユーザーがキャンセルした場合
		}

		const statusManager = StatusManager.getInstance();
		const filePath = item.filePath; // 型安全性のためローカル変数に保存

		let result: TransCommandResult | undefined;

		try {
			// StatusManagerを通じてisTranslatingを設定
			await statusManager.changeFileStatus(filePath, { isTranslating: true });

			// withProgressで進捗表示とキャンセル機能を提供
			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: vscode.l10n.t(
						"Translating {0}",
						vscode.Uri.file(filePath).fsPath.split(/[\\/]/).pop() || filePath,
					),
					cancellable: true,
				},
				async (progress, token) => {
					try {
						// 内部実装を直接呼び出し（二重のwithProgressを回避）
						result = await transFile_CoreProc(
							vscode.Uri.file(filePath),
							progress,
							token,
						);
					} finally {
						// StatusManagerを通じてisTranslatingを解除
						await statusManager.changeFileStatus(filePath, {
							isTranslating: false,
						});
					}
				},
			);
		} catch (error) {
			logger.error("trans", "Error during file translation", formatError(error));
			vscode.window.showErrorMessage(
				vscode.l10n.t(
					"Error during file translation: {0}",
					(error as Error).message,
				),
			);
		}

		return result;
	}

	/**
	 * 単一ユニットを翻訳する
	 */
	public async translateUnit(
		item: StatusItem,
	): Promise<TranslateUnitMetrics | undefined> {
		if (item.type !== StatusItemType.Unit || !item.filePath || !item.unitHash) {
			vscode.window.showErrorMessage(vscode.l10n.t("Invalid unit item"));
			return;
		}

		const statusManager = StatusManager.getInstance();
		let result: TranslateUnitMetrics | undefined;

		try {
			// StatusManagerを通じてisTranslatingを設定（これにより親ファイル・ディレクトリも自動更新される）
			statusManager.changeUnitStatus(
				item.unitHash,
				{ isTranslating: true },
				item.filePath,
			);
			result = await transUnitCommand(item.filePath, item.unitHash);
		} catch (error) {
			logger.error("trans", "Error during unit translation", formatError(error));
			vscode.window.showErrorMessage(
				vscode.l10n.t(
					"Error during unit translation: {0}",
					(error as Error).message,
				),
			);
		} finally {
			// StatusManagerを通じてisTranslatingを解除（これにより親ファイル・ディレクトリも自動更新される）
			statusManager.changeUnitStatus(
				item.unitHash,
				{ isTranslating: false },
				item.filePath,
			);
		}

		return result;
	}
}
