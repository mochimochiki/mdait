/**
 * @file command-expand.ts
 * @description mdait.term.expand コマンド実装
 * 検出済み用語を対象言語に展開する
 */

import * as vscode from "vscode";

import { Configuration } from "../../config/configuration";
import type { StatusItem } from "../../core/status/status-item";

/**
 * 用語展開コマンド（mdait.term.expand）
 * 検出済み用語を指定されたターゲット言語に展開
 *
 * @param item ステータスツリーアイテム（ターゲット言語のルートディレクトリ）
 * @param options オプション設定
 * @param options.showProgress 進捗通知を表示するか（デフォルト: true）
 * @param options.showCompletionMessage 完了メッセージを表示するか（デフォルト: true）
 */
export async function expandTermCommand(
	item?: StatusItem,
	options?: {
		showProgress?: boolean;
		showCompletionMessage?: boolean;
	},
): Promise<void> {
	const { showProgress = true, showCompletionMessage = true } = options || {};
	const config = Configuration.getInstance();

	if (!item) {
		vscode.window.showErrorMessage(vscode.l10n.t("No target directory selected for term expansion."));
		return;
	}

	try {
		// ターゲットディレクトリの情報を取得
		if (item.type !== "directory" || !item.directoryPath) {
			vscode.window.showErrorMessage(vscode.l10n.t("Invalid directory item"));
			return;
		}

		const targetDir = item.directoryPath;
		const transPair = config.getTransPairForTargetFile(targetDir);

		if (!transPair) {
			vscode.window.showErrorMessage(vscode.l10n.t("No translation pair found for target: {0}", targetDir));
			return;
		}

		const sourceDir = transPair.sourceDir;
		const targetLang = targetDir.split(/[/\\]/).pop() || "unknown";
		const sourceLang = sourceDir.split(/[/\\]/).pop() || "unknown";

		// モック: ダイアログ表示
		const message = vscode.l10n.t(
			"Expand terms from {0} to {1}\n\nThis will:\n1. Extract term pairs from existing translations\n2. Translate remaining terms using AI\n3. Update the glossary file",
			sourceLang,
			targetLang,
		);

		await vscode.window.showInformationMessage(message, { modal: true });

		// TODO: 実際の展開処理を実装
		// 1. Phase 1: 既存対訳ファイルから用語対応を抽出
		// 2. Phase 2: 未解決用語をAIで翻訳
		// 3. 用語集CSVに統合・保存

		if (showCompletionMessage) {
			vscode.window.showInformationMessage(
				vscode.l10n.t("Term expansion completed ({0} → {1})", sourceLang, targetLang),
			);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : vscode.l10n.t("Unknown error during term expansion");
		vscode.window.showErrorMessage(vscode.l10n.t("Error during term expansion: {0}", message));
	}
}
