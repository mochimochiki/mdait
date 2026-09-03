import * as fs from "node:fs"; // @important Node.jsのbuilt-inモジュールのimportでは`node:`を使用
import * as path from "node:path";
import * as vscode from "vscode";
import { clampConcurrency, runWithConcurrency } from "../commands/shared/concurrency";
import { OperationRegistry } from "../commands/shared/operation-registry";
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
	/** AI の答えが使えず、訳さずに残したユニット数（need はそのまま残っている） */
	unusableResponses?: number;
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

			// 各ファイルを並列翻訳（trans.concurrency、キャンセルチェック付き）。
			// 異なるファイルペアは独立で、同一ファイルはFileMutexが排他するため競合しない
			const concurrency = clampConcurrency(config.trans.concurrency);
			const outcomes = await runWithConcurrency(
				targetFiles,
				concurrency,
				async (file): Promise<TranslateFileResult> => {
					// 人間の翻訳と重なったら断る。エージェントだけ台帳を通らないと、
					// 待ち行列に並んだ末に古い解析結果で失敗する経路が残る
					const handle = OperationRegistry.getInstance().acquire({
						kind: "translate",
						scope: "file",
						path: file,
					});
					if (!handle) {
						return {
							path: file,
							ok: false,
							error: "Another translation is already running for this file",
						};
					}
					try {
						const result = await transFile_CoreProc(vscode.Uri.file(file), dummyProgress, token);
						// 翻訳ペアが無いのは成功ではない。
						// 成功扱いにするとエージェントが「訳し終えた」と誤って判断する
						if (result.outcome === "no-trans-pair") {
							return {
								path: file,
								ok: false,
								error: "No translation pair found",
							};
						}
						// AI の答えが使えず1件も訳せなかったのも成功ではない。
						// ok:true で translatedUnits:0 を返すと、エージェントは
						// 「訳すものが無かった」と読んで次の工程へ進んでしまう
						if (result.outcome === "failed") {
							return {
								path: file,
								ok: false,
								error:
									result.responseFailures.length > 0
										? "The AI's answer could not be used; nothing was written and the units still need translation"
										: "Translation failed",
							};
						}
						return {
							path: file,
							ok: true,
							translatedUnits: result.translatedCount,
							patchedUnits: result.patchedCount,
							skippedUnits: result.skippedCount,
							tmHits: result.tmHits,
							unusableResponses: result.responseFailures.length || undefined,
						};
					} catch (error) {
						logger.error("LanguageModelTool", "Error translating file", {
							file,
							...formatError(error),
						});
						return {
							path: file,
							ok: false,
							error: (error as Error).message,
						};
					} finally {
						handle.release();
					}
				},
				() => token.isCancellationRequested,
			);

			const fileResults: TranslateFileResult[] = outcomes.filter((r): r is TranslateFileResult => r !== undefined);
			const succeeded = fileResults.filter((r) => r.ok).length;
			const failed = fileResults.filter((r) => !r.ok).length;
			const translatedUnits = fileResults.reduce((sum, r) => sum + (r.translatedUnits ?? 0), 0);
			const cancelled = token.isCancellationRequested && fileResults.length < targetFiles.length;

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

			// 管理対象が1件も無かったスコープを成功として返さない。
			// `ok` しか見ない相手には「0 file(s) succeeded」が成功に見え、
			// 原文側のフォルダを渡したエージェントがそのまま完了報告して終わる（実測）
			if (succeeded === 0 && failed === 0 && translatedUnits === 0 && scopeStatus.totalUnits === 0) {
				const message = vscode.l10n.t(
					"Nothing to translate under {0}: no managed translation file matched. Pass a target-side (translated) file or directory.",
					inputPath,
				);
				return toToolResult(
					createErrorEnvelope(message, ToolErrorCode.InvalidPath, message, [
						"mdait translates the target (translated) side. Run mdait_getStatus with no path to see which files are managed.",
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

			const nextActions = buildNextActions(scopeStatus.needs, scopeStatus.errorUnits, 0, scopeStatus.totalUnits);
			if (failed > 0) {
				nextActions.unshift(
					`${failed} file(s) failed to translate. Inspect data.files[].error for causes, fix them, and run mdait_translate again for the same path (successful units are not re-translated).`,
				);
			}
			return toToolResult(createOkEnvelope(summary, data, nextActions));
		} catch (error) {
			logger.error("LanguageModelTool", "Error in translate tool", { error });
			const errorMessage = vscode.l10n.t("Failed to translate: {0}", (error as Error).message);
			return toToolResult(createErrorEnvelope(errorMessage, ToolErrorCode.InternalError, (error as Error).message));
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
			const fileNeedCount = needs.translate + needs.revise;
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
					: vscode.l10n.t("Translate file: {0}?\n\nThis will translate {1} units using AI.", inputPath, needCount),
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
