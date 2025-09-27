/**
 * @file status-tree-term-handler.ts
 * @description ステータスツリーアイテムの用語検出アクションハンドラ
 * バッチ処理と並行処理でパフォーマンス最適化
 */

import * as vscode from "vscode";
import { Configuration } from "../../config/configuration";
import { StatusItemType } from "../../core/status/status-item";
import type { StatusItem } from "../../core/status/status-item";
import { StatusManager } from "../../core/status/status-manager";
import type { StatusTreeProvider } from "../../ui/status/status-tree-provider";
import { FileExplorer } from "../../utils/file-explorer";
import { detectTermCommand } from "./command-detect";

/**
 * ステータスツリーアイテムの用語検出アクションハンドラ
 */
export class StatusTreeTermHandler {
	private statusTreeProvider?: StatusTreeProvider;

	/**
	 * StatusTreeProviderを設定する
	 */
	public setStatusTreeProvider(provider: StatusTreeProvider): void {
		this.statusTreeProvider = provider;
	}

	/**
	 * ディレクトリ内のソースMarkdownファイルに対して用語検出を実行
	 * 並行処理でパフォーマンス最適化
	 */
	public async termDetectDirectory(item: StatusItem): Promise<void> {
		// 前提チェック（ディレクトリアイテムであること）
		if (item.type !== StatusItemType.Directory || !item.directoryPath) {
			vscode.window.showErrorMessage(vscode.l10n.t("Invalid directory item"));
			return;
		}

		// 確認ダイアログを表示
		const confirmation = await vscode.window.showInformationMessage(
			vscode.l10n.t("Detect terms for all files in directory '{0}'?", item.directoryPath),
			{ modal: true },
			vscode.l10n.t("Yes"),
			vscode.l10n.t("No"),
		);

		if (confirmation !== vscode.l10n.t("Yes")) {
			return;
		}

		// 設定とファイル探索ユーティリティ
		const config = Configuration.getInstance();
		const fileExplorer = new FileExplorer();
		const statusManager = StatusManager.getInstance();

		try {
			// ディレクトリ配下のMarkdownを列挙
			const pattern = new vscode.RelativePattern(item.directoryPath, "**/*.md");
			const files = await vscode.workspace.findFiles(pattern);

			// ソースファイルのみに絞り込み
			const sourceFiles = files.filter((f) => fileExplorer.isSourceFile(f.fsPath, config));
			if (sourceFiles.length === 0) {
				vscode.window.showInformationMessage(
					vscode.l10n.t("No Markdown files found in directory '{0}'", item.directoryPath),
				);
				return;
			}

			// すでに処理中のファイルをスキップ
			const tree = statusManager.getStatusItemTree();
			const eligible = sourceFiles.filter((f) => !tree.getFile(f.fsPath)?.isTranslating);
			const skipped = sourceFiles.length - eligible.length;
			if (skipped > 0) {
				vscode.window.showInformationMessage(
					vscode.l10n.t("{0} files are already processing and were skipped.", skipped),
				);
			}
			if (eligible.length === 0) {
				return;
			}

			// isTranslating を設定（スピナー表示）
			const lockedPaths = eligible.map((u) => u.fsPath);
			await Promise.all(lockedPaths.map((p) => statusManager.changeFileStatus(p, { isTranslating: true })));

			// バッチ処理統計
			let successful = 0;
			let failed = 0;

			try {
				// 進捗通知（並行処理・キャンセル可）
				await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						cancellable: true,
						title: vscode.l10n.t("Detecting terms for directory"),
					},
					async (progress, token) => {
						const total = eligible.length;
						const concurrency = 3; // 並行処理ファイル数

						// チャンク分割
						for (let i = 0; i < eligible.length; i += concurrency) {
							if (token.isCancellationRequested) break;

							const chunk = eligible.slice(i, i + concurrency);

							// チャンク内並行処理
							const chunkPromises = chunk.map(async (file) => {
								try {
									await detectTermCommand(file);
									successful++;
									return true;
								} catch (error) {
									console.error(`Failed to process ${file.fsPath}:`, error);
									failed++;
									return false;
								}
							});

							await Promise.all(chunkPromises);

							// 進捗更新
							const completed = successful + failed;
							const increment = total > 0 ? (chunk.length * 100) / total : 0;
							progress.report({
								increment,
								message: vscode.l10n.t("Processed {0}/{1} files", completed, total),
							});
						}
					},
				);
			} finally {
				// isTranslating を解除
				await Promise.all(lockedPaths.map((p) => statusManager.changeFileStatus(p, { isTranslating: false })));
			}

			// 結果の表示
			if (failed > 0) {
				vscode.window.showWarningMessage(
					vscode.l10n.t(
						"Directory term detection completed: {0} files succeeded, {1} files failed",
						successful,
						failed,
					),
				);
			} else {
				vscode.window.showInformationMessage(
					vscode.l10n.t("Directory term detection completed: {0} files processed", successful),
				);
			}
		} catch (error) {
			// 想定外エラー（ログ出力＋ユーザー通知）
			console.error("Error during directory term detection:", error);
			vscode.window.showErrorMessage(
				vscode.l10n.t("Error during directory term detection: {0}", (error as Error).message),
			);
		}
	}

	/**
	 * 単一ファイル（ソース）に対して用語検出を実行
	 */
	public async termDetectFile(item: StatusItem): Promise<void> {
		// 前提チェック（ファイルアイテムであること）
		if (item.type !== StatusItemType.File || !item.filePath) {
			vscode.window.showErrorMessage(vscode.l10n.t("Invalid file item"));
			return;
		}

		// 設定とファイル探索ユーティリティ
		const config = Configuration.getInstance();
		const fileExplorer = new FileExplorer();

		// finally で参照するため先に保持
		const sourceFilePath: string = item.filePath;

		try {
			// ソースファイルでない場合はエラー
			if (!fileExplorer.isSourceFile(sourceFilePath, config)) {
				vscode.window.showErrorMessage(vscode.l10n.t("File is not a source file: {0}", sourceFilePath));
				return;
			}

			// 多重実行のブロック
			const existing = StatusManager.getInstance().getStatusItemTree().getFile(sourceFilePath);
			if (existing?.isTranslating) {
				vscode.window.showInformationMessage(
					vscode.l10n.t("File is already processing and was skipped: {0}", sourceFilePath),
				);
				return;
			}

			// isTranslating を設定
			await StatusManager.getInstance().changeFileStatus(sourceFilePath, { isTranslating: true });

			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					cancellable: false,
					title: vscode.l10n.t("Detecting terms for file"),
				},
				async (progress) => {
					progress.report({ message: sourceFilePath });
					await detectTermCommand(vscode.Uri.file(sourceFilePath));
				},
			);
		} catch (error) {
			// 想定外エラー（ログ出力＋ユーザー通知）
			console.error("Error during file term detection:", error);
			vscode.window.showErrorMessage(vscode.l10n.t("Error during file term detection: {0}", (error as Error).message));
		} finally {
			// isTranslating を解除
			await StatusManager.getInstance().changeFileStatus(sourceFilePath, { isTranslating: false });
		}
	}
}
