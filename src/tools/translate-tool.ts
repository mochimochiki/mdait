import * as vscode from "vscode";
import { transFile_CoreProc } from "../commands/trans/trans-command";
import { Configuration } from "../config/configuration";
import { StatusManager } from "../core/status/status-manager";
import { AIOnboarding } from "../utils/ai-onboarding";
import { FileExplorer } from "../utils/file-explorer";
import { Logger } from "../utils/logger";

const logger = Logger.getInstance();

/**
 * 入力パラメータ: 翻訳ツール
 */
interface TranslateInput {
	filePath: string; // 翻訳対象ファイルの相対パスまたは絶対パス
}

/**
 * mdaitの翻訳ツール
 * GitHub Copilot Chatから翻訳を実行するためのツール
 */
export class MdaitTranslateTool implements vscode.LanguageModelTool<TranslateInput> {
	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<TranslateInput>,
		token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const { filePath } = options.input;
			logger.info("LanguageModelTool", "Translate tool invoked", { filePath });

			// URIを解決
			let uri: vscode.Uri;
			try {
				uri = vscode.Uri.file(filePath);
			} catch (error) {
				const message = vscode.l10n.t("Invalid file path: {0}", filePath);
				return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(message)]);
			}

			// ファイルがターゲットファイルか確認
			const config = Configuration.getInstance();
			let fileExplorer: FileExplorer;
			try {
				fileExplorer = new FileExplorer();
			} catch (error) {
				const message = vscode.l10n.t("No workspace folder is open.");
				return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(message)]);
			}
			const transPair = fileExplorer.getTransPairFromTarget(filePath, config);
			if (!transPair) {
				const message = vscode.l10n.t(
					"File is not a translation target. Only target files can be translated: {0}",
					filePath,
				);
				return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(message)]);
			}

			// AI初回チェック（Tool経由でもチェックを実施）
			const aiOnboarding = AIOnboarding.getInstance();
			const shouldProceed = await aiOnboarding.checkAndShowFirstUseDialog();
			if (!shouldProceed) {
				const message = vscode.l10n.t("Translation cancelled by user.");
				return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(message)]);
			}

			// ダミーのprogressオブジェクトを作成（Tool APIではwithProgressが使えない）
			const dummyProgress: vscode.Progress<{ message?: string; increment?: number }> = {
				report: () => {
					// 何もしない
				},
			};

			// 翻訳を実行
			await transFile_CoreProc(uri, dummyProgress, token);

			// 翻訳後のステータスを取得
			const statusManager = StatusManager.getInstance();
			await statusManager.refreshFileStatus(filePath);
			const tree = statusManager.getStatusItemTree();
			const fileItem = tree.getFile(filePath);

			if (!fileItem) {
				const message = vscode.l10n.t("Translation completed for: {0}", filePath);
				return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(message)]);
			}

			const units = tree.getUnitsInFile(filePath);
			const translatedUnits = units.filter((u) => u.needFlag === undefined || u.needFlag === null).length;
			const needTranslateUnits = units.filter((u) => u.needFlag === "translate").length;
			const needReviseUnits = units.filter((u) => u.needFlag?.startsWith("revise")).length;

			const resultText = vscode.l10n.t(
				"Translation completed for: {0}\n\nStatus:\n- Total units: {1}\n- Translated: {2}\n- Still needs translation: {3}\n- Still needs revision: {4}",
				filePath,
				units.length,
				translatedUnits,
				needTranslateUnits,
				needReviseUnits,
			);

			return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(resultText)]);
		} catch (error) {
			logger.error("LanguageModelTool", "Error in translate tool", { error });
			const errorMessage = vscode.l10n.t("Failed to translate: {0}", (error as Error).message);
			return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(errorMessage)]);
		}
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<TranslateInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.PreparedToolInvocation> {
		const { filePath } = options.input;

		// 対象ファイルの翻訳必要ユニット数を取得
		const statusManager = StatusManager.getInstance();
		const tree = statusManager.getStatusItemTree();
		const units = tree.getUnitsInFile(filePath);
		const needCount = units.filter(
			(u) => u.needFlag === "translate" || u.needFlag?.startsWith("revise"),
		).length;

		// 翻訳対象ファイルとユニット数を表示して確認を求める
		return {
			invocationMessage: vscode.l10n.t("Translating file..."),
			confirmationMessages: {
				title: vscode.l10n.t("Confirm Translation"),
				message: vscode.l10n.t(
					"Translate file: {0}?\n\nThis will translate {1} units using AI.",
					filePath,
					needCount,
				),
			},
		};
	}
}
