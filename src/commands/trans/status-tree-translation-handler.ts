import * as vscode from "vscode";
import { StatusItemType } from "../../ui/status/status-item";
import type { StatusItem } from "../../ui/status/status-item";
import type { StatusTreeProvider } from "../../ui/status/status-tree-provider";
import { transCommand } from "./trans-command";

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

		try {
			// ディレクトリ配下のMarkdownファイルを取得
			const pattern = new vscode.RelativePattern(item.directoryPath, "**/*.md");
			const files = await vscode.workspace.findFiles(pattern);

			if (files.length === 0) {
				vscode.window.showInformationMessage(
					vscode.l10n.t("No Markdown files found in directory '{0}'", item.directoryPath),
				);
				return;
			}

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
					vscode.l10n.t(
						"Directory translation completed: {0} files succeeded, {1} files failed",
						successful,
						failed,
					),
				);
			}

			// ステータスツリーを更新
			await this.refreshStatusTree();
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
		try {
			item.isTranslating = true;
			if (this.statusTreeProvider) {
				this.statusTreeProvider.refresh(item);
			}
			await transCommand(vscode.Uri.file(item.filePath));
		} catch (error) {
			console.error("Error during file translation:", error);
			vscode.window.showErrorMessage(
				vscode.l10n.t("Error during file translation: {0}", (error as Error).message),
			);
		} finally {
			item.isTranslating = false;
			if (this.statusTreeProvider) {
				this.statusTreeProvider.refresh();
			}
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

		// 現在のtransCommandはファイル単位での翻訳のため、
		// ユニット単位の翻訳については将来実装する
		vscode.window.showInformationMessage(
			vscode.l10n.t(
				"Unit-specific translation is not yet implemented. Translating entire file instead.",
			),
		);
		try {
			item.isTranslating = true;
			if (this.statusTreeProvider) {
				this.statusTreeProvider.refresh(item);
			}
			await transCommand(vscode.Uri.file(item.filePath));
		} catch (error) {
			console.error("Error during unit translation:", error);
			vscode.window.showErrorMessage(
				vscode.l10n.t("Error during unit translation: {0}", (error as Error).message),
			);
		} finally {
			item.isTranslating = false;
			if (this.statusTreeProvider) {
				this.statusTreeProvider.refresh(item);
			}
		}
	}
}
