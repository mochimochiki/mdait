import * as vscode from "vscode";
import { StatusItemType } from "../../core/status/status-item";
import type { StatusItem } from "../../core/status/status-item";
import { StatusManager } from "../../core/status/status-manager";
import type { StatusTreeProvider } from "../../ui/status/status-tree-provider";
import { transCommand, transUnitCommand } from "./trans-command";

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
	 * ステータスツリーを更新する
	 */
	private async refreshStatusTree(): Promise<void> {
		if (this.statusTreeProvider) {
			await this.statusTreeProvider.refresh();
		}
	}

	/**
	 * ディレクトリ内の全ファイルを翻訳する
	 */
	public async translateDirectory(item: StatusItem): Promise<void> {
		if (item.type !== StatusItemType.Directory || !item.directoryPath) {
			vscode.window.showErrorMessage(vscode.l10n.t("Invalid directory item"));
			return;
		}

		const confirmation = await vscode.window.showInformationMessage(
			vscode.l10n.t("Translate all files in directory '{0}'?", item.directoryPath),
			{ modal: true },
			vscode.l10n.t("Yes"),
			vscode.l10n.t("No"),
		);

		if (confirmation !== vscode.l10n.t("Yes")) {
			return;
		}

		const statusManager = StatusManager.getInstance();
		let files: vscode.Uri[] = [];

		try {
			// ディレクトリ配下のMarkdownファイルを取得
			const pattern = new vscode.RelativePattern(item.directoryPath, "**/*.md");
			files = await vscode.workspace.findFiles(pattern);

			if (files.length === 0) {
				vscode.window.showInformationMessage(
					vscode.l10n.t("No Markdown files found in directory '{0}'", item.directoryPath),
				);
				return;
			}

			// 各ファイルのステータスを更新
			await Promise.all(files.map((file) => statusManager.changeFileStatus(file.fsPath, { isTranslating: true })));

			// 各ファイルに対して翻訳を実行
			const results = await Promise.allSettled(
				files.map(async (file) => {
					return transCommand(file);
				}),
			);

			// 結果を集計
			const successful = results.filter((r) => r.status === "fulfilled").length;
			const failed = results.filter((r) => r.status === "rejected").length;

			if (failed > 0) {
				vscode.window.showWarningMessage(
					vscode.l10n.t("Directory translation completed: {0} files succeeded, {1} files failed", successful, failed),
				);
			}
		} catch (error) {
			console.error("Error during directory translation:", error);
			vscode.window.showErrorMessage(
				vscode.l10n.t("Error during directory translation: {0}", (error as Error).message),
			);
		} finally {
			// 各ファイルのステータスを更新
			if (files.length > 0) {
				await Promise.all(files.map((file) => statusManager.changeFileStatus(file.fsPath, { isTranslating: false })));
			}
			// ステータスツリーを更新
			await this.refreshStatusTree();
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

		const statusManager = StatusManager.getInstance();

		try {
			// StatusManagerを通じてisTranslatingを設定
			await statusManager.changeFileStatus(item.filePath, { isTranslating: true });
			await transCommand(vscode.Uri.file(item.filePath));
		} catch (error) {
			console.error("Error during file translation:", error);
			vscode.window.showErrorMessage(vscode.l10n.t("Error during file translation: {0}", (error as Error).message));
		} finally {
			// StatusManagerを通じてisTranslatingを解除
			await statusManager.changeFileStatus(item.filePath, { isTranslating: false });
		}
	}

	/**
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
