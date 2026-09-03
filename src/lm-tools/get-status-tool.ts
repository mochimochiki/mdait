import * as path from "node:path";
import * as vscode from "vscode";
import {
	getSelectedScopeFiles,
	getSelectedTargetLabels,
} from "../commands/shared/status-scope";
import { StatusManager } from "../core/status/status-manager";
import type { FileStatusItem } from "../core/status/status-item";
import { Logger } from "../infra/logging/logger";
import { ToolErrorCode, createErrorEnvelope, createOkEnvelope } from "./envelope";
import { buildNextActions } from "./next-actions";
import { buildStatusData } from "./status-data";
import { toToolResult } from "./tool-result";

const logger = Logger.getInstance();

/**
 * 入力パラメータ: ステータス取得ツール
 */
interface GetStatusInput {
	/** ファイルまたはディレクトリのパス。省略時はワークスペース全体 */
	path?: string;
	/** 後方互換用の旧パラメータ名（path と同義） */
	filePath?: string;
	/** true のときファイル別の need 内訳を含める */
	detail?: boolean;
}

/**
 * mdaitのステータス取得ツール
 * GitHub Copilot Chatから翻訳状況を取得するためのツール
 * 出力は共通エンベロープのJSON文字列（docs/design/agent-orchestration.md 参照）
 */
export class MdaitGetStatusTool implements vscode.LanguageModelTool<GetStatusInput> {
	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<GetStatusInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const statusManager = StatusManager.getInstance();

			// StatusManagerが初期化されていない場合はビルド
			if (statusManager.getStatusItemTree().isEmpty()) {
				logger.info("LanguageModelTool", "Building status tree for the first time");
				await statusManager.buildStatusItemTree();
			}
			// buildStatusItemTree はツリーをインスタンスごと差し替えるため、
			// ビルド後に取り直す（ビルド前に掴むと常に空のツリーを見てしまう）
			const tree = statusManager.getStatusItemTree();

			const scopePath = options.input.path ?? options.input.filePath;
			const detail = options.input.detail === true;

			// スコープのファイル群を解決（ファイル / ディレクトリ / 全体）
			let files: FileStatusItem[];
			let scopeLabel: string;
			if (scopePath) {
				const resolved = resolveScopePath(scopePath);
				const fileItem = tree.getFile(resolved);
				if (fileItem) {
					files = [fileItem];
				} else {
					files = tree.getFilesInDirectoryRecursive(resolved);
				}
				scopeLabel = scopePath;
				if (files.length === 0) {
					const message = vscode.l10n.t("File not found in status tree: {0}", scopePath);
					return toToolResult(
						createErrorEnvelope(message, ToolErrorCode.InvalidPath, message, [
							"Run mdait_sync first to build markers, or check the path.",
						]),
					);
				}
			} else {
				// パス未指定の全体集計は、人間のステータスツリーと同じく選択中の
				// transPair に絞る。範囲が分かるようラベルに対象言語を添える
				// （明示的にパスを指定された場合はその指定を尊重し、絞り込まない）。
				files = getSelectedScopeFiles(tree);
				const targets = getSelectedTargetLabels();
				scopeLabel =
					targets.length > 0 ? `workspace (targets: ${targets.join(", ")})` : "workspace";
			}

			const data = buildStatusData(files, detail);
			const untranslated = data.totalUnits - data.translatedUnits;
			const summary = vscode.l10n.t(
				"Translation status for {0}: {1} total units, {2} translated, {3} untranslated, {4} error(s). Files needing work: {5}.",
				scopeLabel,
				data.totalUnits,
				data.translatedUnits,
				untranslated,
				data.errorUnits,
				data.filesWithNeeds,
			);
			const summaryWithOrphans =
				data.orphanTargets.length > 0
					? `${summary} ${vscode.l10n.t("{0} translation file(s) have no source file.", data.orphanTargets.length)}`
					: summary;

			const nextActions = buildNextActions(data.needs, data.errorUnits, data.orphanTargets.length, data.totalUnits);
			return toToolResult(createOkEnvelope(summaryWithOrphans, data, nextActions));
		} catch (error) {
			logger.error("LanguageModelTool", "Error in getStatus tool", { error });
			const errorMessage = vscode.l10n.t("Failed to get translation status: {0}", (error as Error).message);
			return toToolResult(
				createErrorEnvelope(errorMessage, ToolErrorCode.InternalError, (error as Error).message),
			);
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

/**
 * 入力パスをステータスツリーのキー（絶対パス）へ解決する
 */
function resolveScopePath(inputPath: string): string {
	if (path.isAbsolute(inputPath)) {
		return inputPath;
	}
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	return workspaceRoot ? path.resolve(workspaceRoot, inputPath) : inputPath;
}
