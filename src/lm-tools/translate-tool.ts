import * as fs from "node:fs"; // @important Node.jsのbuildinモジュールのimportでは`node:`を使用
import * as path from "node:path";
import * as vscode from "vscode";
import { transFile_CoreProc } from "../commands/trans/trans-command";
import { StatusManager } from "../core/status/status-manager";
import { Configuration } from "../infra/config/configuration";
import { Logger, formatError } from "../infra/logging/logger";
import { AIOnboarding } from "../infra/onboarding/ai-onboarding";
import { FileExplorer } from "../infra/workspace/file-explorer";
import { ToolErrorCode, createErrorEnvelope, createOkEnvelope } from "./envelope";
import { buildNextActions } from "./next-actions";
import { buildStatusData, countNeeds } from "./status-data";
import { toToolResult } from "./tool-result";

const logger = Logger.getInstance();

/**
 * 入力パラメータ: 翻訳ツール
 */
interface TranslateInput {
	/** 翻訳対象のファイルまたはディレクトリのパス（相対または絶対） */
	path?: string;
	/** 後方互換用の旧パラメータ名（path と同義） */
	filePath?: string;
}

/** ファイルごとの翻訳結果 */
interface TranslateFileResult {
	path: string;
	ok: boolean;
	/** 翻訳したユニット数 */
	translatedUnits?: number;
	/** patchMode（diff-aware revise）で翻訳したユニット数 */
	patchedUnits?: number;
	/** スキップしたユニット数 */
	skippedUnits?: number;
	/** TM参照ヒット数 */
	tmHits?: number;
	/** 失敗時の原因 */
	error?: string;
}

/** mdait_translate の data 形式 */
interface TranslateData {
	scope: "file" | "directory";
	path: string;
	totals: {
		files: number;
		succeeded: number;
		failed: number;
		/** 翻訳ペア対象外のためスキップしたファイル数 */
		skippedNonTarget: number;
		translatedUnits: number;
	};
	files: TranslateFileResult[];
	/** 翻訳後のスコープ内 need 内訳 */
	remainingNeeds?: ReturnType<typeof countNeeds>;
}

/**
 * mdaitの翻訳ツール
 * GitHub Copilot Chatから翻訳を実行するためのツール。
 * ファイル単位・ディレクトリ単位（配下の全ターゲットファイル）の両方に対応する。
 * 出力は共通エンベロープのJSON文字列（docs/design/agent-orchestration.md 参照）
 */
export class MdaitTranslateTool implements vscode.LanguageModelTool<TranslateInput> {
	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<TranslateInput>,
		token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const inputPath = options.input.path ?? options.input.filePath;
			logger.info("LanguageModelTool", "Translate tool invoked", { inputPath });

			if (!inputPath) {
				const message = vscode.l10n.t("No path specified for translation.");
				return toToolResult(createErrorEnvelope(message, ToolErrorCode.InvalidPath, message));
			}

			const config = Configuration.getInstance();
			let fileExplorer: FileExplorer;
			try {
				fileExplorer = new FileExplorer();
			} catch (error) {
				const message = vscode.l10n.t("No workspace folder is open.");
				return toToolResult(createErrorEnvelope(message, ToolErrorCode.NoWorkspace, message));
			}

			const absPath = resolveInputPath(inputPath);
			if (!fs.existsSync(absPath)) {
				const message = vscode.l10n.t("Path not found: {0}", inputPath);
				return toToolResult(createErrorEnvelope(message, ToolErrorCode.InvalidPath, message));
			}

			// AI初回チェック（Tool経由でもチェックを実施）
			// NOTE: prepareInvocation()はside-effect禁止のため、invoke()で実施
			const aiOnboarding = AIOnboarding.getInstance();
			const shouldProceed = await aiOnboarding.checkAndShowFirstUseDialog();
			if (!shouldProceed) {
				const message = vscode.l10n.t("Translation cancelled by user.");
				return toToolResult(createErrorEnvelope(message, ToolErrorCode.UserDeclined, message));
			}

			const isDirectory = fs.statSync(absPath).isDirectory();

			// 対象ターゲットファイルを列挙
			let targetFiles: string[];
			let skippedNonTarget = 0;
			if (isDirectory) {
				const globPattern = FileExplorer.buildExtensionGlob(config.trans.extensions);
				const pattern = new vscode.RelativePattern(absPath, globPattern);
				const found = await vscode.workspace.findFiles(pattern, config.ignoredPatterns);
				targetFiles = [];
				for (const uri of found) {
					if (fileExplorer.getTransPairFromTarget(uri.fsPath, config)) {
						targetFiles.push(uri.fsPath);
					} else {
						skippedNonTarget++;
					}
				}
			} else {
				if (!fileExplorer.getTransPairFromTarget(absPath, config)) {
					const message = vscode.l10n.t(
						"File is not a translation target. Only target files can be translated: {0}",
						inputPath,
					);
					return toToolResult(createErrorEnvelope(message, ToolErrorCode.NotTargetFile, message));
				}
				targetFiles = [absPath];
			}

			// ダミーのprogressオブジェクトを作成（Tool APIではwithProgressが使えない）
			const dummyProgress: vscode.Progress<{ message?: string; increment?: number }> = {
				report: () => {
					// No-op
				},
			};

			// 各ファイルを順次翻訳（キャンセルチェック付き）
			const fileResults: TranslateFileResult[] = [];
			let succeeded = 0;
			let failed = 0;
			let translatedUnits = 0;
			let cancelled = false;
			for (const file of targetFiles) {
				if (token.isCancellationRequested) {
					cancelled = true;
					break;
				}
				try {
					const result = await transFile_CoreProc(vscode.Uri.file(file), dummyProgress, token);
					succeeded++;
					translatedUnits += result?.translatedCount ?? 0;
					fileResults.push({
						path: file,
						ok: true,
						translatedUnits: result?.translatedCount ?? 0,
						patchedUnits: result?.patchedCount ?? 0,
						skippedUnits: result?.skippedCount ?? 0,
						tmHits: result?.tmHits ?? 0,
					});
				} catch (error) {
					failed++;
					logger.error("LanguageModelTool", "Error translating file", {
						file,
						...formatError(error),
					});
					fileResults.push({
						path: file,
						ok: false,
						error: (error as Error).message,
					});
				}
			}

			// 翻訳後のスコープ内ステータスを集計
			const statusManager = StatusManager.getInstance();
			const tree = statusManager.getStatusItemTree();
			const scopeFiles = isDirectory
				? tree.getFilesInDirectoryRecursive(absPath)
				: [tree.getFile(absPath)].filter((f): f is NonNullable<typeof f> => !!f);
			const scopeStatus = buildStatusData(scopeFiles, false);

			const data: TranslateData = {
				scope: isDirectory ? "directory" : "file",
				path: inputPath,
				totals: {
					files: targetFiles.length,
					succeeded,
					failed,
					skippedNonTarget,
					translatedUnits,
				},
				files: fileResults,
				remainingNeeds: scopeStatus.needs,
			};

			if (cancelled) {
				const message = vscode.l10n.t(
					"Translation cancelled: {0} file(s) processed before cancellation.",
					succeeded + failed,
				);
				return toToolResult(
					createErrorEnvelope(message, ToolErrorCode.Cancelled, message, [
						"Run mdait_translate again with the same path to process the remaining files (already-translated units are skipped).",
					]),
				);
			}

			const summary = vscode.l10n.t(
				"Translation completed for {0}: {1} file(s) succeeded, {2} failed, {3} unit(s) translated.",
				inputPath,
				succeeded,
				failed,
				translatedUnits,
			);

			const nextActions = buildNextActions(scopeStatus.needs, scopeStatus.errorUnits);
			if (failed > 0) {
				nextActions.unshift(
					`${failed} file(s) failed to translate. Inspect data.files[].error for causes, fix them, and run mdait_translate again for the same path (successful units are not re-translated).`,
				);
			}
			return toToolResult(createOkEnvelope(summary, data, nextActions));
		} catch (error) {
			logger.error("LanguageModelTool", "Error in translate tool", { error });
			const errorMessage = vscode.l10n.t("Failed to translate: {0}", (error as Error).message);
			return toToolResult(
				createErrorEnvelope(errorMessage, ToolErrorCode.InternalError, (error as Error).message),
			);
		}
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<TranslateInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.PreparedToolInvocation> {
		const inputPath = options.input.path ?? options.input.filePath ?? "";
		const absPath = resolveInputPath(inputPath);

		// スコープ内の翻訳必要ユニット総数を取得（ディレクトリはスコープ単位1回の確認とする）
		const statusManager = StatusManager.getInstance();
		const tree = statusManager.getStatusItemTree();
		const isDirectory = fs.existsSync(absPath) && fs.statSync(absPath).isDirectory();
		const files = isDirectory
			? tree.getFilesInDirectoryRecursive(absPath)
			: [tree.getFile(absPath)].filter((f): f is NonNullable<typeof f> => !!f);
		let needCount = 0;
		let fileCount = 0;
		for (const file of files) {
			const needs = countNeeds(file.children ?? []);
			const fileNeedCount = needs.translate + needs.revise + needs.backfill;
			if (fileNeedCount > 0) {
				fileCount++;
				needCount += fileNeedCount;
			}
		}

		// 翻訳対象スコープとユニット数を表示して確認を求める
		return {
			invocationMessage: vscode.l10n.t("Translating..."),
			confirmationMessages: {
				title: vscode.l10n.t("Confirm Translation"),
				message: isDirectory
					? vscode.l10n.t(
							"Translate directory: {0}?\n\nThis will translate {1} units across {2} files using AI.",
							inputPath,
							needCount,
							fileCount,
						)
					: vscode.l10n.t(
							"Translate file: {0}?\n\nThis will translate {1} units using AI.",
							inputPath,
							needCount,
						),
			},
		};
	}
}

/**
 * 入力パスを絶対パスへ解決する
 */
function resolveInputPath(inputPath: string): string {
	if (path.isAbsolute(inputPath)) {
		return inputPath;
	}
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	return workspaceRoot ? path.resolve(workspaceRoot, inputPath) : inputPath;
}
