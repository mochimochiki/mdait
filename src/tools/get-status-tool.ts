import * as vscode from "vscode";
import { StatusManager } from "../core/status/status-manager";
import { Logger } from "../utils/logger";

const logger = Logger.getInstance();

/**
 * 入力パラメータ: ステータス取得ツール
 */
interface GetStatusInput {
	filePath?: string; // オプション: 特定ファイルのステータスのみ
}

/**
 * mdaitのステータス取得ツール
 * GitHub Copilot Chatから翻訳状況を取得するためのツール
 */
export class MdaitGetStatusTool implements vscode.LanguageModelTool<GetStatusInput> {
	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<GetStatusInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const statusManager = StatusManager.getInstance();
			const tree = statusManager.getStatusItemTree();

			// StatusManagerが初期化されていない場合はビルド
			if (tree.isEmpty()) {
				logger.info("LanguageModelTool", "Building status tree for the first time");
				await statusManager.buildStatusItemTree();
			}

			const { filePath } = options.input;

			// 特定ファイルのステータスを取得
			if (filePath) {
				const fileItem = tree.getFile(filePath);
				if (!fileItem) {
					const message = vscode.l10n.t("File not found in status tree: {0}", filePath);
					return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(message)]);
				}

				const units = tree.getUnitsInFile(filePath);
				const translatedUnits = units.filter((u) => u.needFlag === undefined || u.needFlag === null).length;
				const needTranslateUnits = units.filter((u) => u.needFlag === "translate").length;
				const needReviseUnits = units.filter((u) => u.needFlag?.startsWith("revise")).length;

				const resultText = vscode.l10n.t(
					"Translation status for {0}:\n- Total units: {1}\n- Translated: {2}\n- Needs translation: {3}\n- Needs revision: {4}",
					filePath,
					units.length,
					translatedUnits,
					needTranslateUnits,
					needReviseUnits,
				);

				return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(resultText)]);
			}

			// 全体サマリを取得
			const progress = tree.aggregateProgress();
			const untranslatedUnits = progress.totalUnits - progress.translatedUnits;

			const resultText = vscode.l10n.t(
				"Overall translation status:\n- Total units: {0}\n- Translated: {1}\n- Untranslated: {2}\n- Error: {3}",
				progress.totalUnits,
				progress.translatedUnits,
				untranslatedUnits,
				progress.errorUnits,
			);

			return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(resultText)]);
		} catch (error) {
			logger.error("LanguageModelTool", "Error in getStatus tool", { error });
			const errorMessage = vscode.l10n.t("Failed to get translation status: {0}", (error as Error).message);
			return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(errorMessage)]);
		}
	}

	async prepareInvocation(
		_options: vscode.LanguageModelToolInvocationPrepareOptions<GetStatusInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.PreparedToolInvocation> {
		// 読み取り専用なので確認不要
		return {
			invocationMessage: vscode.l10n.t("Getting translation status..."),
		};
	}
}
