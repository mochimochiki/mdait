import * as vscode from "vscode";
import { StatusItemType } from "../../core/status/status-item";
import type { StatusItem } from "../../core/status/status-item";
import { StatusManager } from "../../core/status/status-manager";
import type { StatusTreeProvider } from "../../ui/status/status-tree-provider";
import { AIOnboarding } from "../../utils/ai-onboarding";
import { transFile_CoreProc, transUnitCommand } from "./trans-command";

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
	public async translateDirectory(item: StatusItem): Promise<void> {
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
			// ディレクトリ配下のMarkdownファイルを取得
			const pattern = new vscode.RelativePattern(directoryPath, "**/*.md");
			const files = await vscode.workspace.findFiles(pattern);

			if (files.length === 0) {
				vscode.window.showInformationMessage(
					vscode.l10n.t("No Markdown files found in directory '{0}'", directoryPath),
				);
				return;
			}

			// withProgressで進捗表示とキャンセル機能を統合管理
			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: vscode.l10n.t("Translating directory '{0}'", directoryPath),
					cancellable: true,
				},
				async (progress, token) => {
					// ディレクトリの翻訳状態を設定
					await statusManager.changeDirectoryStatus(directoryPath, { isTranslating: true });

					try {
						// 各ファイルに対して翻訳を順次実行（キャンセルチェック付き）
						let successful = 0;
						let failed = 0;

						for (let i = 0; i < files.length; i++) {
							// ディレクトリのキャンセルチェック
							if (token.isCancellationRequested) {
								console.log(`Directory translation cancelled, skipping remaining files`);
								vscode.window.showInformationMessage(
									vscode.l10n.t(
										"Directory translation cancelled: {0} files succeeded, {1} files failed, {2} files skipped",
										successful,
										failed,
										files.length - successful - failed,
									),
								);
								break; // finallyでクリーンアップされる
							}

							const file = files[i]; // 進捗報告
							progress.report({
								message: vscode.l10n.t("{0}/{1} files", i + 1, files.length),
								increment: 100 / files.length,
							});

							try {
								// 内部実装を直接呼び出し（二重のwithProgressを回避）
								await transFile_CoreProc(file, progress, token);
								successful++;
							} catch (error) {
								console.error(`Error translating file ${file.fsPath}:`, error);
								failed++;
							}
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
					} finally {
						// ディレクトリの翻訳状態をクリア
						await statusManager.changeDirectoryStatus(directoryPath, { isTranslating: false });
					}
				},
			);
		} catch (error) {
			console.error("Error during directory translation:", error);
			vscode.window.showErrorMessage(
				vscode.l10n.t("Error during directory translation: {0}", (error as Error).message),
			);
		}
	}

	/**
	 * 単一ファイルを翻訳する
	 */
	public async translateFile(item: StatusItem): Promise<void> {
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

		try {
			// StatusManagerを通じてisTranslatingを設定
			await statusManager.changeFileStatus(filePath, { isTranslating: true });

			// withProgressで進捗表示とキャンセル機能を提供
			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: vscode.l10n.t("Translating {0}", vscode.Uri.file(filePath).fsPath.split(/[\\/]/).pop() || filePath),
					cancellable: true,
				},
				async (progress, token) => {
					try {
						// 内部実装を直接呼び出し（二重のwithProgressを回避）
						await transFile_CoreProc(vscode.Uri.file(filePath), progress, token);
					} finally {
						// StatusManagerを通じてisTranslatingを解除
						await statusManager.changeFileStatus(filePath, { isTranslating: false });
					}
				},
			);
		} catch (error) {
			console.error("Error during file translation:", error);
			vscode.window.showErrorMessage(vscode.l10n.t("Error during file translation: {0}", (error as Error).message));
		}
	} /**
	 * 単一ユニットを翻訳する
	 */
	public async translateUnit(item: StatusItem): Promise<void> {
		if (item.type !== StatusItemType.Unit || !item.filePath || !item.unitHash) {
			vscode.window.showErrorMessage(vscode.l10n.t("Invalid unit item"));
			return;
		}

		const statusManager = StatusManager.getInstance();

		try {
			// StatusManagerを通じてisTranslatingを設定（これにより親ファイル・ディレクトリも自動更新される）
			statusManager.changeUnitStatus(item.unitHash, { isTranslating: true }, item.filePath);
			await transUnitCommand(item.filePath, item.unitHash);
		} catch (error) {
			console.error("Error during unit translation:", error);
			vscode.window.showErrorMessage(vscode.l10n.t("Error during unit translation: {0}", (error as Error).message));
		} finally {
			// StatusManagerを通じてisTranslatingを解除（これにより親ファイル・ディレクトリも自動更新される）
			statusManager.changeUnitStatus(item.unitHash, { isTranslating: false }, item.filePath);
		}
	}
}
