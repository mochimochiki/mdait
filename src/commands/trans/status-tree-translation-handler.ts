import * as path from "node:path";
import * as vscode from "vscode";
import { StatusItemType } from "../../core/status/status-item";
import type { DirectoryStatusItem, StatusItem } from "../../core/status/status-item";
import { StatusManager } from "../../core/status/status-manager";
import { Configuration } from "../../infra/config/configuration";
import { isOperationCancelled } from "../../infra/errors/operation-cancelled";
import { Logger, formatError } from "../../infra/logging/logger";
import { AIOnboarding } from "../../infra/onboarding/ai-onboarding";
import { FileExplorer } from "../../infra/workspace/file-explorer";
import type { StatusTreeProvider } from "../../ui/status/status-tree-provider";
import { clampConcurrency, runWithConcurrency } from "../shared/concurrency";
import { showDirectoryTranslationFailure, showTranslationError } from "../shared/guidance";
import { OperationRegistry } from "../shared/operation-registry";
import { getSelectedPairAbsDirs } from "../shared/status-scope";
import {
	type TransCommandResult,
	transCommand,
	transFile_CoreProc,
	transUnitCommand,
} from "./trans-command";

export interface DirectoryTranslationResult {
	totalFiles: number;
	successful: number;
	failed: number;
	skipped: number;
}

const logger = Logger.getInstance();

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
	 * 翻訳待ちが残っている訳文ルートを翻訳する（sync 完了通知の「今すぐ翻訳」の実体）。
	 *
	 * sync 直後にはアクティブなエディタが無いのが普通なので、ファイルを1つ選ばせずに
	 * 「いま翻訳待ちのユニットがあるペア」をそのまま対象にする。ペアが複数あるときだけ
	 * どれを訳すか尋ねる。
	 */
	public async translatePendingTargets(): Promise<void> {
		const config = Configuration.getInstance();
		const tree = StatusManager.getInstance().getStatusItemTree();

		// 翻訳待ちが残っているターゲットルートだけを候補にする
		const candidates = getSelectedPairAbsDirs(config)
			.map((pair) => ({
				dirItem: tree.getDirectory(pair.targetDirAbs),
				pending: tree.countPendingTranslationUnits([pair.targetDirAbs]),
			}))
			.filter(
				(c): c is { dirItem: DirectoryStatusItem; pending: number } =>
					c.dirItem !== undefined && c.pending > 0,
			);

		if (candidates.length === 0) {
			vscode.window.showInformationMessage(
				vscode.l10n.t("No units are waiting for translation."),
			);
			return;
		}

		if (candidates.length === 1) {
			await this.translateDirectory(candidates[0].dirItem);
			return;
		}

		const picked = await vscode.window.showQuickPick(
			candidates.map((c) => ({
				label: c.dirItem.label,
				description: vscode.l10n.t("{0} unit(s) waiting", c.pending),
				dirItem: c.dirItem,
			})),
			{ title: vscode.l10n.t("Which translation do you want to run?") },
		);
		if (picked) {
			await this.translateDirectory(picked.dirItem);
		}
	}

	/**
	 * ディレクトリ内の全ファイルを翻訳する
	 */
	public async translateDirectory(item: StatusItem): Promise<DirectoryTranslationResult | undefined> {
		if (item.type !== StatusItemType.Directory || !item.directoryPath) {
			vscode.window.showErrorMessage(vscode.l10n.t("Invalid directory item"));
			return;
		}

		const directoryPath = item.directoryPath; // 型安全性のためローカル変数に保存

		try {
			// ディレクトリ配下の翻訳対象ファイルを取得（.md + trans.extensions）。
			// 確認ダイアログに対象ファイル数を出すため、確認より先に列挙する
			const config = Configuration.getInstance();
			const globPattern = FileExplorer.buildExtensionGlob(
				config.trans.extensions,
			);
			const pattern = new vscode.RelativePattern(directoryPath, globPattern);
			const files = await vscode.workspace.findFiles(pattern, config.ignoredPatterns);

			if (files.length === 0) {
				vscode.window.showInformationMessage(
					vscode.l10n.t(
						"No translatable files found in directory '{0}'",
						directoryPath,
					),
				);
				return { totalFiles: 0, successful: 0, failed: 0, skipped: 0 };
			}

			const confirmation = await vscode.window.showInformationMessage(
				vscode.l10n.t("Translate all files in directory '{0}'? ({1} file(s))", directoryPath, files.length),
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

			// 多重起動の拒否。配下のファイル翻訳とも範囲が重なるため、
			// 台帳が「いま重なる操作が走っているか」を一手に判定する
			const handle = OperationRegistry.getInstance().acquire({
				kind: "translate",
				scope: "directory",
				path: directoryPath,
			});
			if (!handle) {
				vscode.window.showInformationMessage(
					vscode.l10n.t(
						"{0} is already being translated. Wait for it to finish, or cancel it first.",
						path.basename(directoryPath),
					),
				);
				return undefined;
			}

			// withProgressで進捗表示とキャンセル機能を統合管理。
			// 台帳の解放は withProgress の外側で行う — 中の finally だけだと、
			// withProgress 自体が失敗したときに登録が残り、以後この対象を永久に断ってしまう
			try {
				return await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: vscode.l10n.t("Translating directory '{0}'", directoryPath),
						cancellable: true,
					},
					async (progress, token) => {
						try {
							// 各ファイルをtrans.concurrencyの同時実行数で並列翻訳（キャンセルチェック付き）。
							// 異なるファイルペアは独立で、同一ファイルはFileMutexが排他するため競合しない
							let successful = 0;
							let failed = 0;
							let completed = 0;
							// 中断されたファイル・訳すものが無かったファイルは、
							// 成功にも失敗にも数えない（数え分けないと結果報告が嘘になる）
							let cancelledFiles = 0;
							let untouched = 0;
							// 最初の失敗理由を保持して結果通知に載せる。件数だけを出すと、
							// AI が使えないだけなのか原稿の問題なのかが利用者に分からない
							let firstError: unknown;
							const concurrency = clampConcurrency(config.trans.concurrency);

							await runWithConcurrency(
								files,
								concurrency,
								async (file) => {
									try {
										// 内部実装を直接呼び出し（二重のwithProgressを回避）。
										// 終わり方で数え分ける — 中断は失敗でも成功でもない。
										// 以前は「5件失敗」と出ても実際はユーザーが止めただけ、が起きていた
										const fileResult = await transFile_CoreProc(file, progress, token);
										if (fileResult.outcome === "no-trans-pair") {
											failed++;
											if (!firstError) {
												firstError = new Error(
													vscode.l10n.t("No translation pair found for file: {0}", file.fsPath),
												);
											}
										} else if (fileResult.outcome === "cancelled") {
											cancelledFiles++;
										} else if (fileResult.outcome === "nothing-to-do") {
											untouched++;
										} else if (fileResult.outcome === "failed") {
											// 例外は出ていないが訳せていない（AI の答えが使えなかった）。
											// 成功に数えると「N件翻訳しました」と嘘になる
											failed++;
											if (!firstError) {
												firstError = new Error(
													fileResult.responseFailures.length > 0
														? vscode.l10n.t(
																"The AI's answer could not be used for {0}.",
																path.basename(file.fsPath),
															)
														: vscode.l10n.t("Translation failed for {0}.", path.basename(file.fsPath)),
												);
											}
										} else {
											successful++;
											// 一部のユニットだけ訳せなかったファイルも黙って通さない。
											// ファイル単位の通知は出していないので、ここで残さないと誰も気づけない
											if (fileResult.responseFailures.length > 0) {
												logger.warn("trans", "Some units were left untranslated (unusable AI response)", {
													file: file.fsPath,
													count: fileResult.responseFailures.length,
													reasons: fileResult.responseFailures.map((f) => f.reason),
												});
											}
										}
									} catch (error) {
										// 中断は失敗ではない
										if (isOperationCancelled(error)) {
											return;
										}
										logger.error("trans", "Error translating file", {
											file: file.fsPath,
											...formatError(error),
										});
										if (!firstError) {
											firstError = error;
										}
										failed++;
									}
									completed++;
									progress.report({
										message: vscode.l10n.t("{0}/{1} files", completed, files.length),
										increment: 100 / files.length,
									});
								},
								() => token.isCancellationRequested,
							);

							// キャンセル時は未着手ファイル数を報告
							if (token.isCancellationRequested) {
								logger.info(
									"trans",
									"Directory translation cancelled, skipping remaining files",
								);
								const skipped = files.length - successful - failed + cancelledFiles;
								vscode.window.showInformationMessage(
									vscode.l10n.t(
										"Directory translation cancelled: {0} files succeeded, {1} files failed, {2} files skipped",
										successful,
										failed,
										skipped,
									),
								);
								return { totalFiles: files.length, successful, failed, skipped };
							}

							// 結果を通知（失敗があれば理由と次の一手を添える）。
							// 成功しても黙らない — ここは sync 完了通知の「✨今すぐ翻訳」から
							// 来る主導線で、無言で終わると次の工程へ手渡せない（UX-P6）
							if (failed > 0) {
								void showDirectoryTranslationFailure(successful, failed, firstError);
							} else if (successful > 0) {
								vscode.window.showInformationMessage(
									vscode.l10n.t(
										"Translation completed for {0}: {1} file(s).",
										path.basename(directoryPath),
										successful,
									),
								);
							} else {
								vscode.window.showInformationMessage(
									vscode.l10n.t("Nothing to translate in {0}.", path.basename(directoryPath)),
								);
							}
							return { totalFiles: files.length, successful, failed, skipped: untouched };
						} finally {
							// 進行中の見え方は台帳が持つため、旗を下ろす処理は無い。
							// 配下ファイルの最終状態はファイル側の後始末で反映済み
						}
					},
				);
			} finally {
				handle.release();
			}
		} catch (error) {
			logger.error("trans", "Error during directory translation", formatError(error));
			vscode.window.showErrorMessage(
				vscode.l10n.t(
					"Error during directory translation: {0}",
					(error as Error).message,
				),
			);
			return undefined;
		}
	}

	/**
	 * 単一ファイルを翻訳する
	 */
	public async translateFile(
		item: StatusItem,
	): Promise<TransCommandResult | undefined> {
		if (item.type !== StatusItemType.File || !item.filePath) {
			vscode.window.showErrorMessage(vscode.l10n.t("Invalid file item"));
			return;
		}

		// ファイル翻訳は transCommand が AI初回確認・多重起動の拒否・進捗・通知まで
		// 面倒を見る。ここで独自に旗を立てたり通知したりしない（サーフェスごとに書くと必ずずれる）
		return (await transCommand(vscode.Uri.file(item.filePath))) ?? undefined;
	}

	/**
	 * 単一ユニットを翻訳する
	 */
	public async translateUnit(
		item: StatusItem,
	): Promise<TransCommandResult | undefined> {
		if (item.type !== StatusItemType.Unit || !item.filePath || !item.unitHash) {
			vscode.window.showErrorMessage(vscode.l10n.t("Invalid unit item"));
			return;
		}

		// 多重起動の拒否・進捗・通知はすべて transUnitCommand が持つ
		try {
			return await transUnitCommand(item.filePath, item.unitHash);
		} catch (error) {
			logger.error("trans", "Error during unit translation", formatError(error));
			await showTranslationError(error);
			return undefined;
		}
	}
}
