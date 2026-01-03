/**
 * @file status-tree-term-handler.ts
 * @description ステータスツリーアイテムの用語検出アクションハンドラ
 * バッチ処理と並行処理でパフォーマンス最適化
 */

import * as vscode from "vscode";
import { Configuration } from "../../config/configuration";
import type { MdaitUnit } from "../../core/markdown/mdait-unit";
import { markdownParser } from "../../core/markdown/parser";
import { StatusItemType } from "../../core/status/status-item";
import type { StatusItem } from "../../core/status/status-item";
import { StatusManager } from "../../core/status/status-manager";
import type { StatusTreeProvider } from "../../ui/status/status-tree-provider";
import { AIOnboarding } from "../../utils/ai-onboarding";
import { FileExplorer } from "../../utils/file-explorer";
import { detectTermBatchInternal } from "./command-detect";
import { expandTermsInternal } from "./command-expand";

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
	 * 全ファイルのUnitを集約してバッチ処理
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

		// AI初回利用チェック
		const aiOnboarding = AIOnboarding.getInstance();
		const shouldProceed = await aiOnboarding.checkAndShowFirstUseDialog();
		if (!shouldProceed) {
			return; // ユーザーがキャンセルした場合
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

			// ソース言語の特定（最初のファイルから判定）
			const transPair = config.getTransPairForSourceFile(eligible[0].fsPath);
			if (!transPair) {
				vscode.window.showErrorMessage(vscode.l10n.t("Unable to determine source language for term detection."));
				return;
			}
			const sourceLang = transPair.sourceLang;

			// isTranslating を設定（スピナー表示）
			const lockedPaths = eligible.map((u) => u.fsPath);
			await Promise.all(lockedPaths.map((p) => statusManager.changeFileStatus(p, { isTranslating: true })));

			// withProgressで進捗表示とキャンセル機能を統合管理
			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: vscode.l10n.t("Detecting terms..."),
					cancellable: true,
				},
				async (progress, token) => {
					try {
						// 全ファイルからUnitを収集
						const allUnits: MdaitUnit[] = [];
						for (const file of eligible) {
							try {
								const document = await vscode.workspace.openTextDocument(file);
								const content = document.getText();
								const markdown = markdownParser.parse(content, config);
								allUnits.push(...markdown.units);
							} catch (error) {
								console.error(`Failed to parse file: ${file.fsPath}`, error);
							}
						}

						if (allUnits.length === 0) {
							vscode.window.showInformationMessage(vscode.l10n.t("No content found for term detection."));
							return;
						}

						// バッチ処理実行（内部実装を直接呼び出し）
						await detectTermBatchInternal(allUnits, sourceLang, progress, token);

						if (!token.isCancellationRequested) {
							vscode.window.showInformationMessage(vscode.l10n.t("Term detection completed successfully."));
						}

						// StatusManagerの更新
						for (const path of lockedPaths) {
							await statusManager.refreshFileStatus(path);
						}
					} finally {
						// isTranslating を解除
						await Promise.all(lockedPaths.map((p) => statusManager.changeFileStatus(p, { isTranslating: false })));
					}
				},
			);
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

		// AI初回利用チェック
		const aiOnboarding = AIOnboarding.getInstance();
		const shouldProceed = await aiOnboarding.checkAndShowFirstUseDialog();
		if (!shouldProceed) {
			return; // ユーザーがキャンセルした場合
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

			// ソース言語の特定
			const transPair = config.getTransPairForSourceFile(sourceFilePath);
			if (!transPair) {
				vscode.window.showErrorMessage(vscode.l10n.t("Unable to determine source language for term detection."));
				return;
			}
			const sourceLang = transPair.sourceLang;

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

			// ファイルをパースしてUnit配列を取得
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(sourceFilePath));
			const content = document.getText();
			const markdown = markdownParser.parse(content, config);

			if (markdown.units.length === 0) {
				vscode.window.showInformationMessage(vscode.l10n.t("No content found for term detection."));
				return;
			}

			// withProgressで進捗表示とキャンセル機能を提供
			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: vscode.l10n.t("Detecting terms for file"),
					cancellable: true,
				},
				async (progress, token) => {
					try {
						// バッチ処理実行（内部実装を直接呼び出し）
						await detectTermBatchInternal(markdown.units, sourceLang, progress, token);

						if (!token.isCancellationRequested) {
							vscode.window.showInformationMessage(vscode.l10n.t("Term detection completed successfully."));
							// StatusManagerの更新
							await StatusManager.getInstance().refreshFileStatus(sourceFilePath);
						}
					} finally {
						// isTranslating を解除
						await StatusManager.getInstance().changeFileStatus(sourceFilePath, { isTranslating: false });
					}
				},
			);
		} catch (error) {
			// 想定外エラー（ログ出力＋ユーザー通知）
			console.error("Error during file term detection:", error);
			vscode.window.showErrorMessage(vscode.l10n.t("Error during file term detection: {0}", (error as Error).message));
		}
	}

	/**
	 * ターゲットディレクトリに対して用語展開を実行
	 * ディレクトリ配下のファイルに対応するソースファイルのみを対象
	 */
	public async termExpandDirectory(item: StatusItem): Promise<void> {
		// 前提チェック（ディレクトリアイテムであること）
		if (item.type !== StatusItemType.Directory || !item.directoryPath) {
			vscode.window.showErrorMessage(vscode.l10n.t("Invalid directory item"));
			return;
		}

		// 設定とファイル探索ユーティリティ
		const config = Configuration.getInstance();
		const fileExplorer = new FileExplorer();

		// ターゲットディレクトリの情報を取得
		const targetDir = item.directoryPath;
		const transPair = config.getTransPairForTargetFile(targetDir);

		if (!transPair) {
			vscode.window.showErrorMessage(vscode.l10n.t("No translation pair found for target: {0}", targetDir));
			return;
		}

		// 確認ダイアログを表示
		const confirmation = await vscode.window.showInformationMessage(
			vscode.l10n.t("Expand terms for all files in directory '{0}'?", item.directoryPath),
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

		try {
			// ディレクトリ配下のMarkdownを列挙
			const pattern = new vscode.RelativePattern(item.directoryPath, "**/*.md");
			const files = await vscode.workspace.findFiles(pattern);

			// ターゲットファイルのみに絞り込み
			const targetFiles = files.filter((f) => fileExplorer.isTargetFile(f.fsPath, config));
			if (targetFiles.length === 0) {
				vscode.window.showInformationMessage(
					vscode.l10n.t("No Markdown files found in directory '{0}'", item.directoryPath),
				);
				return;
			}

			// ソースファイルパスを収集
			const sourceFiles: string[] = [];
			for (const targetFile of targetFiles) {
				const sourcePath = fileExplorer.getSourcePath(targetFile.fsPath, transPair);
				if (sourcePath) {
					sourceFiles.push(sourcePath);
				}
			}

			if (sourceFiles.length === 0) {
				vscode.window.showInformationMessage(vscode.l10n.t("No source files found for term expansion."));
				return;
			}

			// withProgressで進捗表示とキャンセル機能を提供
			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: vscode.l10n.t("Expanding terms ({0} → {1})", transPair.sourceLang, transPair.targetLang),
					cancellable: true,
				},
				async (progress, token) => {
					try {
						await expandTermsInternal(transPair, progress, token, sourceFiles);

						if (!token.isCancellationRequested) {
							vscode.window.showInformationMessage(
								vscode.l10n.t("Term expansion completed ({0} → {1})", transPair.sourceLang, transPair.targetLang),
							);
						}
					} catch (error) {
						const message = error instanceof Error ? error.message : vscode.l10n.t("Unknown error during term expansion");
						vscode.window.showErrorMessage(vscode.l10n.t("Error during term expansion: {0}", message));
					}
				},
			);
		} catch (error) {
			// 想定外エラー（ログ出力＋ユーザー通知）
			console.error("Error during directory term expansion:", error);
			vscode.window.showErrorMessage(
				vscode.l10n.t("Error during directory term expansion: {0}", (error as Error).message),
			);
		}
	}

	/**
	 * ターゲットファイルに対して用語展開を実行
	 * そのファイルに対応するソースファイルのみを対象
	 */
	public async termExpandFile(item: StatusItem): Promise<void> {
		// 前提チェック（ファイルアイテムであること）
		if (item.type !== StatusItemType.File || !item.filePath) {
			vscode.window.showErrorMessage(vscode.l10n.t("Invalid file item"));
			return;
		}

		// 設定とファイル探索ユーティリティ
		const config = Configuration.getInstance();
		const fileExplorer = new FileExplorer();

		// ターゲットファイルの情報を取得
		const targetFilePath = item.filePath;
		const transPair = config.getTransPairForTargetFile(targetFilePath);

		if (!transPair) {
			vscode.window.showErrorMessage(vscode.l10n.t("No translation pair found for target: {0}", targetFilePath));
			return;
		}

		// ソースファイルパスを取得
		const sourceFilePath = fileExplorer.getSourcePath(targetFilePath, transPair);
		if (!sourceFilePath) {
			vscode.window.showErrorMessage(vscode.l10n.t("No source file found for term expansion: {0}", targetFilePath));
			return;
		}

		// AI初回利用チェック
		const aiOnboarding = AIOnboarding.getInstance();
		const shouldProceed = await aiOnboarding.checkAndShowFirstUseDialog();
		if (!shouldProceed) {
			return; // ユーザーがキャンセルした場合
		}

		// withProgressで進捗表示とキャンセル機能を提供
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: vscode.l10n.t("Expanding terms for file ({0} → {1})", transPair.sourceLang, transPair.targetLang),
				cancellable: true,
			},
			async (progress, token) => {
				try {
					await expandTermsInternal(transPair, progress, token, [sourceFilePath]);

					if (!token.isCancellationRequested) {
						vscode.window.showInformationMessage(
							vscode.l10n.t("Term expansion completed ({0} → {1})", transPair.sourceLang, transPair.targetLang),
						);
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : vscode.l10n.t("Unknown error during term expansion");
					vscode.window.showErrorMessage(vscode.l10n.t("Error during term expansion: {0}", message));
				}
			},
		);
	}
}
