import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { UnitStateStore } from "../../core/unit-state/unit-state-store";
import { calculateHash } from "../../core/hash/hash-calculator";
import { FrontMatter } from "../../core/markdown/front-matter";
import {
	calculateFrontmatterHash,
	getFrontmatterTranslationKeys,
	parseFrontmatterMarker,
	setFrontmatterMarker,
} from "../../core/markdown/frontmatter-translation";
import { MdaitMarker } from "../../core/markdown/mdait-marker";
import type { MdaitUnit } from "../../core/markdown/mdait-unit";
import { markdownParser } from "../../core/markdown/parser";
import { DELETE_SUSPICION, isSuspiciousShrink } from "../../core/matching/shrink-guard";
import { SelectionState } from "../../core/status/selection-state";
import { StatusManager } from "../../core/status/status-manager";
import { UnitRegistryManager } from "../../core/unit-registry/unit-registry-manager";
import type { OrphanTargetPolicy, TransPair } from "../../infra/config/configuration";
import { Configuration } from "../../infra/config/configuration";
import { resolveMarkerIO } from "../../infra/config/marker-io";
import { Logger, formatError } from "../../infra/logging/logger";
import { flushDirtyDocument } from "../../infra/workspace/dirty-document";
import { FileExplorer } from "../../infra/workspace/file-explorer";
import { FileMutex } from "../../infra/workspace/file-mutex";
import { ensureMdaitDir } from "../../infra/workspace/mdait-dir";
import { toWorkspaceRelativePath } from "../../infra/workspace/workspace-path";
import type { FileSyncResult } from "../file-handler/file-handler";
import { getFileHandler } from "../file-handler/file-handler-factory";
import { reconcileMarkerModeForFile } from "../markers/markers-migration";
import { AIOnboarding } from "../../infra/onboarding/ai-onboarding";
import { alignMatchResult } from "../adopt/align-core";
import { type SectionAligner, buildSectionAligner } from "../adopt/section-aligner";
import { showConfigError } from "../shared/guidance";
import { getSelectedScopeDirs } from "../shared/status-scope";
import { copyDiffAssets } from "./asset-copier";
import { DiffDetector, type DiffResult, type UnitDiff, DiffType } from "./diff-detector";
import { validateAndSyncLevel } from "./level-validator";
import { syncMarkerPair, syncSourceMarker } from "./marker-sync";
import { SectionMatcher } from "./section-matcher";
import { syncFrontmatterMarkers } from "./sync-frontmatter";

const logger = Logger.getInstance();

/**
 * syncコマンドの結果
 */
export interface SyncResult {
	totalFileCount: number;
	successCount: number;
	errorCount: number;
	totalAdded: number;
	totalModified: number;
	totalDeleted: number;
	totalUnchanged: number;
	/** need:revise付与件数 */
	revisionsNeeded: number;
	/** adoptで採用（need:review付与）したユニット数 */
	totalAdopted: number;
	/** 独立ユニットとして保持している孤立ターゲット数 */
	totalKept: number;
	/** need:review を一次受け付与したマーカーなし孤立ターゲット数 */
	totalOrphanReviewed: number;
	/** 崩れを疑って自動削除を見送り、確認待ちにした孤立ターゲット数 */
	totalOrphanDeletionWithheld: number;
	/** AIアラインが適用した修正提案数 */
	totalAlignCorrections: number;
	durationMs: number;
}

/**
 * syncコマンドのオプション
 */
export interface SyncCommandOptions {
	/**
	 * 採用（adopt）モード: マーカーなし・本文ありの既存訳文を from 確立＋need:review で採用する。
	 * 既存対訳サイトの取り込み用の一度きりの操作であり、永続設定にはしない。
	 */
	adopt?: boolean;
	/**
	 * AIアライン: adopt 時の位置ベース対応付けを AI で差分審査して誤ペアを修正する。
	 * adopt かつ明示指定時のみ発動し、定常 sync では動かない（ADR-260705-01）。
	 */
	align?: boolean;
}

/**
 * sync command
 * Markdownユニットの同期を行う
 */
export async function syncCommand(
	options?: SyncCommandOptions,
): Promise<SyncResult | undefined> {
	const startTime = Date.now();
	try {
		// 準備
		const statusManager = StatusManager.getInstance();
		const config = Configuration.getInstance();
		// validate ではなく validateForRun。sourceDir/targetDir の入れ子など
		// 「走らせると壊れる」組み合わせは、原文を書き換える前に止める必要がある
		const validationError = config.validateForRun();
		if (validationError) {
			await showConfigError(validationError);
			return;
		}

		const pairs = SelectionState.getInstance().filterTransPairs(
			config.transPairs,
		);
		logger.info("sync", "Sync started", {
			pairCount: pairs.length,
		});

		// AIアライン準備: adopt + align 指定時のみ AI を使う。
		// 定常 sync（syncSingleFile 経由）は aligner を作らないため構造的に AI 非実行（ADR-260705-01）。
		let aligner: SectionAligner | undefined;
		if (options?.adopt === true && options?.align === true) {
			const proceed = await AIOnboarding.getInstance().checkAndShowFirstUseDialog();
			if (proceed) {
				aligner = await buildSectionAligner(config);
			} else {
				logger.info(
					"sync",
					"AI align skipped (onboarding declined); continuing with deterministic adopt",
				);
			}
		}

		let successCount = 0;
		let errorCount = 0;
		let totalFileCount = 0;
		let totalAdded = 0;
		let totalModified = 0;
		let totalDeleted = 0;
		let totalUnchanged = 0;
		let totalRevisionsNeeded = 0;
		let totalAdopted = 0;
		let totalKept = 0;
		let totalOrphanReviewed = 0;
		let totalOrphanDeletionWithheld = 0;
		let totalAlignCorrections = 0;

		// UnitStateStoreをロード
		const mdaitDir = await ensureMdaitDir();
		if (mdaitDir) {
			UnitStateStore.getInstance().load(mdaitDir);
		}

		// orphanクリーンアップ用の範囲（詳細は UnitStateStore.cleanupOrphansInScope）。
		// - configuredDirs: config の全 pair のディレクトリ。ここから外れた行は消してよい
		// - scannedDirs:    今回実際に走査できたディレクトリ。ここに無い行は「確かめていない」
		// - seenPaths:      走査して実在を確認したファイル
		const configuredDirs = collectConfiguredDirs(config);
		const scannedDirs = new Set<string>();
		const seenPaths = new Set<string>();

		// TransPairごとに処理
		for (const pair of pairs) {
			// ソースファイル一覧を取得（extensions対応）。
			// 原文ディレクトリが手元に無い（sparse checkout・ブランチ切替・設定ミス）と、ここが
			// throw して sync 全体が止まる。unit-state の行が守られるのは掃除に到達しないためで、
			// 掃除側の分岐で守っているわけではない（実測: 後続ペアも1件も処理されない）。
			const fileExplorer = new FileExplorer();

			const files = await fileExplorer.getSourceFiles(
				pair.sourceDir,
				config,
				config.trans.extensions,
			);
			if (files.length === 0) {
				vscode.window.showWarningMessage(
					vscode.l10n.t(
						"[{0} -> {1}] No files found for synchronization.",
						pair.sourceDir,
						pair.targetDir,
					),
				);
				continue;
			}

			// ここまで来たら「このペアのディレクトリを走査して1件以上見つけた」。
			// 走査したことの登録は必ずファイル列挙の後で行う。前に置くと、ディレクトリは在るのに
			// 0件だったとき（原文を一時的に退避した等）に「全部見たが1件も無かった」と読まれ、
			// そのペアの全行が消える
			scannedDirs.add(toWorkspaceRelativePath(path.resolve(config.getConfigBaseDir(), pair.sourceDir)));
			scannedDirs.add(toWorkspaceRelativePath(path.resolve(config.getConfigBaseDir(), pair.targetDir)));

			// 実在を確認したパスを収集（unit-state の orphan クリーンアップ用）。
			// キーは `UnitStateEntry.path` と同じ基準（ワークスペースルート相対）にそろえる。
			// FileExplorer.normalizePath は設定ベースディレクトリ相対なので、カスタム config
			// パスでは基準が食い違い、非MDの行が毎 sync 全滅する（docs/design/unit-state.md §5-(4)）。
			//
			// MD もマーカー保管方式に関わらず収集する。embedded 運用でも、embed で本文へ
			// 書き戻せなかった行がストアに残ることがあり、それを掃除で消してしまわないため。
			for (const file of files) {
				seenPaths.add(toWorkspaceRelativePath(file));
				const tgt = fileExplorer.getTargetPath(file, pair);
				if (tgt) {
					seenPaths.add(toWorkspaceRelativePath(tgt));
				}
			}

			// CPUコア数に基づく並列処理制限
			const parallelCpuLimit = Math.max(1, Math.min(os.cpus()?.length ?? 4, 8));
			// align 有効時は AI レート制限に配慮して逐次実行する（review 経路と整合）
			const effectiveParallel = aligner ? 1 : parallelCpuLimit;
			let index = 0;

			// ワーカー関数（並列実行処理）
			const worker = async () => {
				while (true) {
					const i = index++;
					if (i >= files.length) break;
					const sourceFile = files[i];
					try {
						// TargetPathを決定
						const targetFile = fileExplorer.getTargetPath(sourceFile, pair);
						if (!targetFile) {
							logger.warn("sync", "Target path could not be determined", {
								sourceFile,
							});
							continue;
						}

						// FileHandlerを取得してdispatch
						// 翻訳・自動syncと同一ファイルへの書き込みが交錯しないよう排他する
						const handler = getFileHandler(sourceFile);
						const syncResult: FileSyncResult =
							await FileMutex.getInstance().runExclusive(
								[sourceFile, targetFile],
								async () => {
									// 未保存のエディタ変更をディスクへ反映してから同期する
									await flushDirtyDocument(sourceFile);
									await flushDirtyDocument(targetFile);
									if (fs.existsSync(targetFile)) {
										return handler.sync(sourceFile, targetFile, options, aligner);
									}
									return handler.syncNew(sourceFile, targetFile);
								},
							);

						// 結果をStatusManagerに反映
						// 変化の有無でログレベルを切り替え
						const hasChanges =
							syncResult.added > 0 ||
							syncResult.modified > 0 ||
							syncResult.deleted > 0;
						if (hasChanges) {
							logger.info("sync", "File synced", {
								pair: `${pair.sourceDir} -> ${pair.targetDir}`,
								file: path.basename(sourceFile),
								added: syncResult.added,
								modified: syncResult.modified,
								deleted: syncResult.deleted,
								unchanged: syncResult.unchanged,
							});
						} else {
							logger.debug("sync", "File synced (no changes)", {
								pair: `${pair.sourceDir} -> ${pair.targetDir}`,
								file: path.basename(sourceFile),
							});
						}
						await statusManager.refreshFileStatus(sourceFile);
						if (fs.existsSync(targetFile)) {
							await statusManager.refreshFileStatus(targetFile);
						} else {
							logger.debug(
								"sync",
								"Skipping target status refresh (file not created)",
								{
									targetFile,
								},
							);
						}
						successCount++;
						totalFileCount++;
						totalAdded += syncResult.added;
						totalModified += syncResult.modified;
						totalDeleted += syncResult.deleted;
						totalUnchanged += syncResult.unchanged;
						totalRevisionsNeeded += syncResult.revisionsNeeded;
						totalAdopted += syncResult.adopted ?? 0;
						totalKept += syncResult.kept ?? 0;
						totalOrphanReviewed += syncResult.orphanReviewed ?? 0;
						totalOrphanDeletionWithheld += syncResult.orphanDeletionWithheld ?? 0;
						totalAlignCorrections += syncResult.alignCorrections ?? 0;
					} catch (error) {
						logger.error("sync", "File sync error", {
							pair: `${pair.sourceDir} -> ${pair.targetDir}`,
							file: sourceFile,
							...formatError(error),
						});
						await statusManager.changeFileStatusWithError(
							sourceFile,
							error as Error,
						);
						errorCount++;
					}
				}
			};

			// ワーカー起動と完了待機
			const workers = Array.from(
				{ length: Math.min(effectiveParallel, files.length) },
				() => worker(),
			);
			await Promise.all(workers);

			// スナップショットバッファをフラッシュ
			const unitRegistryManager = UnitRegistryManager.getInstance();
			await unitRegistryManager.flushBuffer();
		}

		// UnitStateStoreのorphanクリーンアップ＋保存
		if (mdaitDir) {
			const unitStateStore = UnitStateStore.getInstance();
			const orphansRemoved = unitStateStore.cleanupOrphansInScope({
				configuredDirs,
				scannedDirs: [...scannedDirs],
				seenPaths,
			});
			if (orphansRemoved > 0) {
				logger.info("sync", "Cleaned up orphan unit-state entries", {
					orphansRemoved,
				});
			}
			unitStateStore.save(mdaitDir);
		}

		// 全ファイル処理完了後、GC処理
		await runUnitRegistryGC(statusManager);

		const endTime = Date.now();
		const durationMs = endTime - startTime;

		logger.info("sync", "Sync completed", {
			totalFileCount,
			successCount,
			errorCount,
			totalAdded,
			totalModified,
			totalDeleted,
			totalUnchanged,
			revisionsNeeded: totalRevisionsNeeded,
			totalAdopted,
			totalKept,
			totalOrphanReviewed,
			totalOrphanDeletionWithheld,
			totalAlignCorrections,
			durationMs,
		});

		// 翻訳すべきユニットがある場合は「今すぐ翻訳」導線を出す（空ファイルで戸惑わせない: P2）
		// 注: 導線の通知は fire-and-forget にする。ここで await すると通知をユーザーが
		// 閉じるまで syncCommand が解決せず、呼び出し側の処理中フラグ（sync ボタンの
		// くるくるアニメーション）が終わらないため（ADR-260705-01 の非AI sync は同期処理完結が前提）。
		//
		// 件数は「今回の実行で増えた分（totalAdded + totalRevisionsNeeded）」ではなく、
		// sync 後のステータスツリーに残っている翻訳待ち（translate / revise）全体を使う。
		// 前者だけを見ると、変更なしの2回目以降の sync で翻訳待ちが残っているのに
		// 件数と「今すぐ翻訳」ボタンが消えてしまう。
		const translatableCount = statusManager
			.getStatusItemTree()
			.countPendingTranslationUnits(getSelectedScopeDirs(config));
		if (translatableCount > 0) {
			const translateNow = vscode.l10n.t("✨Translate now");
			void vscode.window
				.showInformationMessage(
					vscode.l10n.t(
						"Synchronization completed: {0} succeeded, {1} failed. {2} unit(s) need translation.",
						successCount,
						errorCount,
						translatableCount,
					),
					translateNow,
				)
				.then((choice) => {
					if (choice === translateNow) {
						// mdait.trans は URI 必須の単一ファイル用コマンド。sync 直後は
						// アクティブなエディタが無いのが普通で、引数なしで呼ぶと必ず
						// 「翻訳対象のファイルが選択されていません」で終わっていた。
						// 翻訳待ちが残っている訳文ルートを対象にするコマンドへ委譲する
						return vscode.commands.executeCommand("mdait.trans.pendingTargets");
					}
					return undefined;
				})
				// VS Code の Thenable には .catch が無いため .then の第2引数で拒否を捕捉する。
				// fire-and-forget のため outer try/catch では拾えないので明示的にログ化する。
				.then(undefined, (error) => {
					logger.error("sync", "Post-sync translate guidance failed", {
						...formatError(error),
					});
				});
		} else {
			void vscode.window.showInformationMessage(
				vscode.l10n.t(
					"Synchronization completed: {0} succeeded, {1} failed",
					successCount,
					errorCount,
				),
			);
		}

		// 自動削除を見送った場合は「何も起きなかったように見える」ので必ず伝える。
		// ux.md §3.3 では通知に載せてよいのは「実行の結果と、結果に対する次の一手」。
		// これは sync の実行結果そのもの（＝訳文を消さずに確認待ちにした）なので通知が正しい。
		// 状態はツリー（need:verify-deletion のユニット）に出るので、ここでは件数と入口だけを示す。
		// 明示実行の sync だけが出す（autoSyncOnSave は syncSingleFile 経由で通知を出さない）。
		if (totalOrphanDeletionWithheld > 0) {
			const showList = vscode.l10n.t("Show units");
			void vscode.window
				.showWarningMessage(
					vscode.l10n.t(
						"Sync did not delete {0} translated unit(s) whose source disappeared all at once — this often means the source failed to parse (an unclosed code fence, or a changed sync.level). They are kept and marked for your confirmation. Fix the source and sync again to restore them.",
						totalOrphanDeletionWithheld,
					),
					showList,
				)
				.then((choice) => {
					if (choice === showList) {
						// VS Code が view id から自動生成するフォーカスコマンド
					return vscode.commands.executeCommand("mdait.status.focus");
					}
					return undefined;
				})
				.then(undefined, (error) => {
					logger.error("sync", "Withheld-deletion guidance failed", {
						...formatError(error),
					});
				});
		}

		// 孤立ユニットを削除した場合は復旧導線を示す（訳文消失への気づき: P6）
		// こちらも同様に fire-and-forget（await すると処理中フラグが残る）。
		if (config.getOrphanTargetPolicy() === "delete" && totalDeleted > 0) {
			const restoreHelp = vscode.l10n.t("How to restore");
			void vscode.window
				.showWarningMessage(
					vscode.l10n.t(
						"Sync removed {0} orphaned unit(s) whose source was deleted. If this was unexpected, you can restore them from git, or set sync.autoDelete to false.",
						totalDeleted,
					),
					restoreHelp,
				)
				.then((choice) => {
					if (choice === restoreHelp) {
						return vscode.env.openExternal(
							vscode.Uri.parse(
								"https://github.com/mochimochiki/mdait/blob/main/docs/guide/ja/troubleshooting.md",
							),
						);
					}
					return undefined;
				})
				// VS Code の Thenable には .catch が無いため .then の第2引数で拒否を捕捉する。
				// fire-and-forget のため outer try/catch では拾えないので明示的にログ化する。
				.then(undefined, (error) => {
					logger.error("sync", "Orphan restore guidance failed", {
						...formatError(error),
					});
				});
		}

		return {
			totalFileCount,
			successCount,
			errorCount,
			totalAdded,
			totalModified,
			totalDeleted,
			totalUnchanged,
			revisionsNeeded: totalRevisionsNeeded,
			totalAdopted,
			totalKept,
			totalOrphanReviewed,
			totalOrphanDeletionWithheld,
			totalAlignCorrections,
			durationMs,
		};
	} catch (error) {
		const endTime = Date.now();
		const durationMs = endTime - startTime;
		logger.error("sync", "Sync command failed", {
			durationMs,
			...formatError(error),
		});
		vscode.window.showErrorMessage(
			vscode.l10n.t(
				"An error occurred during synchronization: {0}",
				(error as Error).message,
			),
		);
		return undefined;
	}
}

/**
 * config の全 pair の原文・訳文ディレクトリを、`UnitStateEntry.path` と同じ基準
 * （ワークスペースルート相対・`/` 区切り）で返す。
 *
 * **選択中の pair ではなく config 全体を見る。** 選択は一時的なもので、選択だけを軸にすると
 * 「未選択の言語」と「設定から外された言語」を区別できず、掃除が永久に効かなくなる。
 */
function collectConfiguredDirs(config: Configuration): string[] {
	const baseDir = config.getConfigBaseDir();
	const dirs = new Set<string>();
	for (const pair of config.transPairs) {
		dirs.add(toWorkspaceRelativePath(path.resolve(baseDir, pair.sourceDir)));
		dirs.add(toWorkspaceRelativePath(path.resolve(baseDir, pair.targetDir)));
	}
	return [...dirs];
}

/**
 * 単一ファイルの同期を行う
 * ファイル保存時に呼び出され、そのファイルと関連するペアファイルのみを同期する
 *
 * @param filePath 保存されたファイルのパス
 */
export async function syncSingleFile(filePath: string): Promise<void> {
	try {
		const config = Configuration.getInstance();
		const validationError = config.validate();
		if (validationError) {
			logger.warn("sync", "Configuration error during file save sync", {
				validationError,
			});
			return;
		}

		const fileExplorer = new FileExplorer();
		const statusManager = StatusManager.getInstance();
		const unitRegistryManager = UnitRegistryManager.getInstance();

		// ファイルがソースかターゲットかを判定し、対応するペアを見つける
		let sourceFile: string | null = null;
		let targetFile: string | null = null;
		let matchedPair: TransPair | null = null;

		// 選択された TransPair のみを処理対象とする
		const pairs = SelectionState.getInstance().filterTransPairs(
			config.transPairs,
		);

		for (const pair of pairs) {
			if (fileExplorer.isSourceFile(filePath, config)) {
				// 保存されたファイルがソースの場合
				const tgtPath = fileExplorer.getTargetPath(filePath, pair);
				if (tgtPath) {
					sourceFile = filePath;
					targetFile = tgtPath;
					matchedPair = pair;
					break;
				}
			} else if (fileExplorer.isTargetFile(filePath, config)) {
				// 保存されたファイルがターゲットの場合
				const srcPath = fileExplorer.getSourcePath(filePath, pair);
				if (srcPath && fs.existsSync(srcPath)) {
					sourceFile = srcPath;
					targetFile = filePath;
					matchedPair = pair;
					break;
				}
			}
		}

		// ペアが見つからない場合は何もしない
		if (!sourceFile || !targetFile || !matchedPair) {
			return;
		}

		// UnitStateStoreの遅延ロード（非MDファイル + MD-external 対応）
		const handler = getFileHandler(sourceFile);
		const needsUnitState = handler.fileType === "plain" || config.isExternalMarkers();
		if (needsUnitState) {
			const mdaitDir = await ensureMdaitDir();
			if (mdaitDir) {
				UnitStateStore.getInstance().ensureLoaded(mdaitDir);
			}
		}

		// FileHandlerを使って同期処理を実行
		// 翻訳・他のsyncと同一ファイルへの書き込みが交錯しないよう排他する
		const src = sourceFile;
		const tgt = targetFile;
		const syncResult: FileSyncResult =
			await FileMutex.getInstance().runExclusive([src, tgt], async () => {
				// ペアファイル側の未保存変更もディスクへ反映してから同期する
				await flushDirtyDocument(src);
				await flushDirtyDocument(tgt);
				if (fs.existsSync(tgt)) {
					return handler.sync(src, tgt);
				}
				return handler.syncNew(src, tgt);
			});

		// スナップショットバッファをフラッシュ
		await unitRegistryManager.flushBuffer();

		// 非MDファイル + MD-external の場合はUnitStateStoreを保存
		if (needsUnitState) {
			const mdaitDir = await ensureMdaitDir();
			if (mdaitDir) {
				UnitStateStore.getInstance().save(mdaitDir);
			}
		}

		// ステータスを更新
		await statusManager.refreshFileStatus(sourceFile);
		await statusManager.refreshFileStatus(targetFile);

		// 変化の有無でログレベルを切り替え
		const hasChanges =
			syncResult.added > 0 || syncResult.modified > 0 || syncResult.deleted > 0;
		if (hasChanges) {
			logger.info("sync", "File sync completed", {
				file: path.basename(filePath),
				added: syncResult.added,
				modified: syncResult.modified,
				deleted: syncResult.deleted,
				unchanged: syncResult.unchanged,
			});
		} else {
			logger.debug("sync", "File sync completed (no changes)", {
				file: path.basename(filePath),
			});
		}
	} catch (error) {
		logger.error("sync", "Error during single file sync", formatError(error));
		// エラーは表示せず、ログに記録のみ（ユーザー体験を妨げない）
	}
}

/**
 * 新規にターゲットファイルを作成する（中核プロセス）
 *
 * 処理フロー:
 * 1. ソースファイル読み込みパース
 * 2. mdaitマーカーとハッシュを付与（source側はneed,fromなし）
 * 3. target用ユニットを生成（from:hash, need:translateを付与）
 * 4. ターゲットファイルとして保存
 * 5. ソースファイルもマーカー付きで更新（need,fromは付与しない）
 * 6. DiffResultを返す
 *
 * @param sourceFile ソースファイルのパス
 * @param targetFile ターゲットファイルのパス
 * @param config 設定
 * @returns 差分検出結果
 */
export async function syncNew_CoreProc(
	sourceFile: string,
	targetFile: string,
	config: Configuration,
): Promise<DiffResult> {
	const fileExplorer = new FileExplorer();

	// 1. ソースファイル読み込み＆パース
	const document = await vscode.workspace.fs.readFile(
		vscode.Uri.file(sourceFile),
	);
	const decoder = new TextDecoder("utf-8");
	const sourceContent = decoder.decode(document);

	// マーカー保管方式に応じた provider/ctx を解決
	const sourceIO = resolveMarkerIO(config, sourceFile, "source");
	const targetIO = resolveMarkerIO(config, targetFile, "target");

	const source = markdownParser.parse(sourceContent, config, sourceIO.provider, sourceIO.ctx);

	// 廃止need（keep/backfill）を新モデルへ正規化する
	normalizeLegacyNeeds(source.units);

	const frontmatterKeys = getFrontmatterTranslationKeys(config);
	const sourceFrontHash = calculateFrontmatterHash(
		source.frontMatter,
		frontmatterKeys,
	);
	const shouldSyncFrontmatter = sourceFrontHash !== null;

	// フロントマターのみのファイルは、frontmatter翻訳が無効なら処理しない
	if (source.units.length === 0 && !shouldSyncFrontmatter) {
		logger.debug(
			"sync",
			"Skipping empty file (no units, no frontmatter translation keys)",
			{ sourceFile },
		);
		return {
			diffs: [],
			added: 0,
			modified: 0,
			deleted: 0,
			unchanged: 0,
		};
	}

	// 2. mdaitマーカーとハッシュを付与（source側はneed,fromなし）
	ensureMdaitMarkerHash(source.units);

	// 2.5. frontmatterマーカーを同期（syncFrontmatterMarkersで統一処理）
	const frontmatterSync = syncFrontmatterMarkers(
		source.frontMatter,
		undefined,
		frontmatterKeys,
	);

	// 3. target用ユニットを生成（from:hash, need:translateを付与）。
	//    need:isolate の source は下流に出さない（伝播停止）
	const exportedSourceUnits = source.units.filter((srcUnit) => srcUnit.marker?.need !== "isolate");
	const targetUnits = exportedSourceUnits.map((srcUnit) => {
		const hash = srcUnit.marker?.hash ?? calculateHash(srcUnit.content);
		const tgtMarker = new MdaitMarker(hash, hash, "translate");
		const tgtUnit = Object.create(Object.getPrototypeOf(srcUnit));
		Object.assign(tgtUnit, srcUnit, { marker: tgtMarker });
		return tgtUnit;
	});

	const targetDoc = {
		frontMatter: frontmatterSync.targetFrontMatter ?? source.frontMatter,
		units: targetUnits,
	};

	// 4. ターゲットファイルとして保存
	const encoder = new TextEncoder();
	const targetContent = markdownParser.stringify(targetDoc, targetIO.provider, targetIO.ctx);
	fileExplorer.ensureTargetDirectoryExists(targetFile);
	await vscode.workspace.fs.writeFile(
		vscode.Uri.file(targetFile),
		encoder.encode(targetContent),
	);

	// 4.5. スナップショット保存（初回sync時も保存）
	const unitRegistryManager = UnitRegistryManager.getInstance();
	for (const srcUnit of source.units) {
		if (srcUnit.marker?.hash) {
			unitRegistryManager.saveUnitRegistry(
				srcUnit.marker.hash,
				srcUnit.content,
			);
		}
	}

	// 5. ソースファイルもマーカー付きで更新（need,fromは付与しない）
	const updatedSourceContent = markdownParser.stringify(
		{
			frontMatter: frontmatterSync.sourceFrontMatter ?? source.frontMatter,
			units: source.units,
		},
		sourceIO.provider,
		sourceIO.ctx,
	);
	await vscode.workspace.fs.writeFile(
		vscode.Uri.file(sourceFile),
		encoder.encode(updatedSourceContent),
	);

	// 6. DiffResultを返す（isolate で target 出力から除外したユニットは追加に数えない）
	const diffs: UnitDiff[] = exportedSourceUnits.map((u) => ({
		type: DiffType.ADDED,
		source: u,
		target: null,
	}));
	const diffResult: DiffResult = {
		diffs,
		added: exportedSourceUnits.length,
		modified: 0,
		deleted: 0,
		unchanged: 0,
	};

	// 差分に応じたアセットコピー（有効/無効・ホワイトリストの解決は asset-copier 側で実施）
	await copyDiffAssets({
		diffs: diffResult.diffs,
		sourceUnits: source.units,
		sourceFile,
		config,
	});

	return diffResult;
}

/**
 * 既存のターゲットファイルを同期する（中核プロセス）
 *
 * 処理フロー:
 * 1. ソースターゲットファイル読み込みパース
 * 2. mdaitマーカーとハッシュを付与（ない場合のみ）
 * 3. ユニットの対応付け（SectionMatcher）
 * 4. ユニットのハッシュ更新とneedフラグ設定
 * 5. 同期結果の生成（追加更新削除の反映）
 * 6. 差分検出
 * 7. ターゲットファイルに保存
 * 8. ソースファイルにもマーカー付きで保存
 *
 * @param sourceFile ソースファイルのパス
 * @param targetFile ターゲットファイルのパス
 * @param config 設定
 * @returns 差分検出結果
 */
export async function sync_CoreProc(
	sourceFile: string,
	targetFile: string,
	config: Configuration,
	options?: SyncCommandOptions,
	aligner?: SectionAligner,
): Promise<DiffResult> {
	const sectionMatcher = new SectionMatcher();
	const diffDetector = new DiffDetector();
	const fileExplorer = new FileExplorer();

	// マーカー保管方式の自己修復: 「本文マーカー運用のサイトを external に切り替えた（逆も）」
	// 動線では markers.mode だけ書き換えて sync するため、物理表現が設定モードとずれ得る。
	// sync 本処理の前に source/target の物理マーカーを設定モードへ寄せ、モード切替→sync を安全にする
	// （目標モード済みなら no-op で低コスト・冪等）。
	const reconcileStore = UnitStateStore.getInstance();
	reconcileMarkerModeForFile(sourceFile, "source", config, reconcileStore);
	reconcileMarkerModeForFile(targetFile, "target", config, reconcileStore);

	// level設定の検証と同期
	await validateAndSyncLevel(sourceFile, targetFile);

	// ファイル読み込み
	const decoder = new TextDecoder("utf-8");
	const sourceDoc = await vscode.workspace.fs.readFile(
		vscode.Uri.file(sourceFile),
	);
	const targetDoc = await vscode.workspace.fs.readFile(
		vscode.Uri.file(targetFile),
	);
	const sourceContent = decoder.decode(sourceDoc);
	const targetContent = decoder.decode(targetDoc);

	// マーカー保管方式（embedded/external）に応じた provider/ctx を解決
	const sourceIO = resolveMarkerIO(config, sourceFile, "source");
	const targetIO = resolveMarkerIO(config, targetFile, "target");

	// external で target に unit-state エントリが無い＝store喪失/手動作成の「rebuild」検知。
	// 既存訳文を need:translate で上書きしないよう、後段で need:review に倒す安全網。
	const targetRel = targetIO.ctx?.filePath;
	const isExternalRebuild =
		config.isExternalMarkers() &&
		targetContent.trim() !== "" &&
		targetRel !== undefined &&
		UnitStateStore.getInstance().getEntriesByPath(targetRel).length === 0;

	// Markdownのユニット分割
	const source = markdownParser.parse(sourceContent, config, sourceIO.provider, sourceIO.ctx);
	const target = markdownParser.parse(targetContent, config, targetIO.provider, targetIO.ctx);

	// 廃止need（keep/backfill）の正規化はパース直後に行う（独立ユニット判定にも影響するため）
	normalizeLegacyNeeds(source.units);
	normalizeLegacyNeeds(target.units);

	// 独立ユニット（target側パススルー保護）の判定 Set。
	// ensureMdaitMarkerHash がマーカーなしユニットへメモリ上で素hashを合成するため、
	// 「ファイルに永続化されたマーカー」を区別できる ensure 前に作る必要がある
	// （パーサーはマーカーなしユニットに hash 空のマーカーを付けるため hash の有無で判定する）。
	// from 付き need:isolate は独立ユニットにしない: 上流ペアは Phase 1 で維持され、
	// need の凍結（suppressNeed）で伝播だけが止まる
	const independentTargets = new Set(
		target.units.filter((u) => u.marker?.hash && !u.marker.from && u.marker.need !== "verify-deletion"),
	);

	const frontmatterKeys = getFrontmatterTranslationKeys(config);
	const frontmatterSync = syncFrontmatterMarkers(
		source.frontMatter,
		target.frontMatter,
		frontmatterKeys,
	);

	// フロントマターのみのファイルは、frontmatter同期が無効なら処理しない
	if (
		source.units.length === 0 &&
		target.units.length === 0 &&
		!frontmatterSync.processed
	) {
		logger.debug(
			"sync",
			"Skipping empty file (no units, no frontmatter changes)",
			{ sourceFile },
		);
		return {
			diffs: [],
			added: 0,
			modified: 0,
			deleted: 0,
			unchanged: 0,
		};
	}

	// src, target に hash を付与（ない場合のみ）
	ensureMdaitMarkerHash(source.units);
	ensureMdaitMarkerHash(target.units);

	// ユニットの対応付け（位置ベース。独立ユニットは対応付け対象外）
	let matchResult = sectionMatcher.match(source.units, target.units, independentTargets);

	// AIアライン: adopt + align 指定かつ aligner 注入時のみ、位置ベース結果を AI で差分審査する。
	// 応答不正・候補なし・上限超過は matchResult をそのまま使う（位置ベースへフォールバック）。
	let alignCorrections = 0;
	if (options?.adopt === true && options?.align === true && aligner) {
		const transPair = fileExplorer.getTransPairFromTarget(targetFile, config);
		if (transPair) {
			const aligned = await alignMatchResult(
				source.units,
				target.units,
				matchResult,
				aligner,
				config,
				{ sourceLang: transPair.sourceLang, targetLang: transPair.targetLang },
				targetFile,
				undefined,
				independentTargets,
			);
			matchResult = aligned.matchResult;
			alignCorrections = aligned.summary.accepted;
		}
	}

	// ユニットのハッシュを更新
	const { revisionsNeeded, adopted, noteMigrations } = updateSectionHashes(
		matchResult,
		config,
		sourceFile,
		targetFile,
		options?.adopt === true,
	);

	// external rebuild 安全網: 既存targetユニットが（fromロストにより）need:translateに
	// なった場合、自動上書きを避けるため need:review に倒す（非MDのrebuild挙動と整合）。
	if (isExternalRebuild) {
		for (const unit of target.units) {
			if (unit.marker?.need === "translate") {
				unit.marker.setNeed("review");
			}
		}
	}

	// sourceのスナップショット保存
	const unitRegistryManager = UnitRegistryManager.getInstance();
	for (const srcUnit of source.units) {
		if (srcUnit.marker?.hash) {
			unitRegistryManager.saveUnitRegistry(
				srcUnit.marker.hash,
				srcUnit.content,
			);
		}
	}
	// 本文編集で hash が変わったユニットの note を旧→新 hash へ移送する
	await unitRegistryManager.migrateNotes(noteMigrations);

	// 同期結果の生成（孤立ターゲットの処理はポリシーに従う。
	// delete=自動削除 / verify=need:verify-deletion付与で手動確認に委ねる（P6対策）。
	// 独立ユニットはポリシーに関わらず保持、マーカーなし孤立は need:review で一次受けする）
	//
	// ただし「原文の構造が潰れた」ときは自動削除しない（下記 resolveOrphanPolicy）。
	const orphanCandidates = countDanglingOrphans(matchResult, independentTargets);
	const withheldPolicy = resolveOrphanPolicy(
		config.getOrphanTargetPolicy(),
		countManagedTargets(target.units, independentTargets),
		countExportedSources(source.units),
		orphanCandidates,
		targetFile,
	);
	const syncedResult = sectionMatcher.createSyncedTargets(
		matchResult,
		withheldPolicy.policy,
		independentTargets,
	);
	const syncedUnits = syncedResult.units;

	// 差分検出
	const diffResult = diffDetector.detect(target.units, syncedUnits);
	diffResult.revisionsNeeded = revisionsNeeded;
	diffResult.adopted = adopted;
	diffResult.kept = syncedResult.orphanKept;
	diffResult.orphanVerified = syncedResult.orphanVerified;
	diffResult.orphanReviewed = syncedResult.orphanReviewed;
	diffResult.orphanDeletionWithheld = withheldPolicy.withheld ? syncedResult.orphanVerified : 0;
	diffResult.alignCorrections = alignCorrections;

	// 同期結果をMarkdownオブジェクトとして構築
	const syncedDoc = {
		frontMatter: frontmatterSync.targetFrontMatter ?? target.frontMatter,
		units: syncedUnits,
	};

	// 同期結果を文字列に変換（external では本文にマーカーを出力せず store へ detach）
	const syncedContent = markdownParser.stringify(syncedDoc, targetIO.provider, targetIO.ctx);

	// 出力先ディレクトリが存在するか確認し、なければ作成
	fileExplorer.ensureTargetDirectoryExists(targetFile);

	// ファイル出力
	const encoder = new TextEncoder();
	await vscode.workspace.fs.writeFile(
		vscode.Uri.file(targetFile),
		encoder.encode(syncedContent),
	);

	// source側にもmdaitマーカー・hashを必ず付与・更新し、ファイル保存
	// frontmatterSync.sourceFrontMatterにはsource側のマーカーが設定済み
	const updatedSourceContent = markdownParser.stringify(
		{
			frontMatter: frontmatterSync.sourceFrontMatter ?? source.frontMatter,
			units: source.units,
		},
		sourceIO.provider,
		sourceIO.ctx,
	);

	await vscode.workspace.fs.writeFile(
		vscode.Uri.file(sourceFile),
		encoder.encode(updatedSourceContent),
	);

	// 差分に応じたアセットコピー（有効/無効・ホワイトリストの解決は asset-copier 側で実施）
	await copyDiffAssets({
		diffs: diffResult.diffs,
		sourceUnits: source.units,
		sourceFile,
		config,
	});

	return diffResult;
}

/**
 * 原文を失った（dangling）訳文ユニットの数を数える。
 *
 * 独立ユニット・`need:isolate`・マーカーなしの管理外コンテンツは、もともと自動削除の
 * 対象ではないので数えない（`createSyncedTargets` の分岐と対応させる）。
 */
function countDanglingOrphans(
	matchResult: { source: MdaitUnit | null; target: MdaitUnit | null }[],
	independentTargets: ReadonlySet<MdaitUnit>,
): number {
	let count = 0;
	for (const pair of matchResult) {
		if (pair.source || !pair.target) continue;
		if (independentTargets.has(pair.target) || pair.target.marker?.need === "isolate") continue;
		const marker = pair.target.marker;
		if (marker?.from || marker?.need === "verify-deletion") {
			count++;
		}
	}
	return count;
}

/**
 * 自動削除の対象になりうる訳文ユニット（＝原文と対応しているはずのユニット）の数を数える。
 *
 * 独立ユニット・`need:isolate`・マーカーなしの管理外コンテンツは、もともと自動削除の
 * 対象ではないので数えない。この数が「原文の構造が潰れたか」を測るときの分母になる。
 */
function countManagedTargets(targetUnits: readonly MdaitUnit[], independentTargets: ReadonlySet<MdaitUnit>): number {
	let count = 0;
	for (const unit of targetUnits) {
		if (independentTargets.has(unit) || unit.marker?.need === "isolate") continue;
		if (unit.marker?.from || unit.marker?.need === "verify-deletion") {
			count++;
		}
	}
	return count;
}

/**
 * 下流へ出る原文ユニット（`need:isolate` は伝播しないので除く）の数を数える。
 */
function countExportedSources(sourceUnits: readonly MdaitUnit[]): number {
	return sourceUnits.filter((u) => u.marker?.need !== "isolate").length;
}

/**
 * 孤立ユニットの扱いを決める。**原文の構造が潰れたときは自動削除しない。**
 *
 * 原文にコードブロックの閉じ忘れが1つ入るだけで、以降の見出しが全部コードとして飲まれ、
 * 訳文の章がまとめて「原文を失った」状態になる。既定設定（`sync.autoDelete: true`）では
 * それが**訳文の物理削除**になり、フェンスを直しても訳は戻らない（git からしか戻せない）。
 * 実測: 7章の訳文がフェンス1つで全部消え、直したあとは全ユニット `need:translate` になった。
 *
 * `unit-state` の行を守るのと同じ判定（`isSuspiciousShrink`）を本文にも当てる。
 * 行だけ守って本文を消していては「見えていないものを無いと断定しない」原則が成立しない。
 * 慎重さは削除側（`DELETE_SUSPICION`）を使う。崩れは文書の大きさに関係なく1ユニットまで
 * 潰すので、「残りが1件以下」なら減少幅が1件でも疑う。刈り取り側の下限（3件）をそのまま
 * 使うと、見出し2つの README のような小さい文書が素通りする。
 *
 * **何を数えるかが要点。** 見るのは「**原文のユニット数**」であって「対応が付いた数」ではない。
 * この2つは小さい文書で見分けがつかず、対応が付いた数で判断すると普通の編集を崩れと誤認する。
 *
 * | 場面 | 原文 | 訳文 | 対応が付いた数 |
 * |---|---|---|---|
 * | フェンス崩れ（本物） | **1**（8から潰れた） | 8 | 1 |
 * | 2ユニットの1章を編集 | **2**（潰れていない） | 2 | 1 |
 *
 * 対応が付いた数だけを見ると後者も「残り1件」に見え、古い章が `verify-deletion` として
 * 本文に残り、訳文に同じ章が2つ並ぶ（実測。原文がマーカーを失った状態で編集すると起きる）。
 * 原文のユニット数を見れば、崩れていない（2 対 2）ことが分かる。
 *
 * どちらも**いまの数**しか使わないので、前回の状態を持たない embedded でも同じように効く。
 *
 * 止めるときは黙って残すのではなく `verify`（`need:verify-deletion`）へ倒す。
 * 削除が本当に正しければ人が確定でき、原文が戻れば `updateSectionHashes` が自動で解除する。
 * need の語彙は増やしていない（既存のポリシーへ倒すだけ）。
 */
function resolveOrphanPolicy(
	configured: OrphanTargetPolicy,
	managedTargetCount: number,
	sourceUnitCount: number,
	orphanCandidates: number,
	targetFile: string,
): { policy: OrphanTargetPolicy; withheld: boolean } {
	if (configured !== "delete" || orphanCandidates === 0) {
		return { policy: configured, withheld: false };
	}
	if (!isSuspiciousShrink(managedTargetCount, sourceUnitCount, DELETE_SUSPICION)) {
		return { policy: configured, withheld: false };
	}
	logger.warn("sync", "Withheld automatic deletion of orphaned target units (the source structure collapsed)", {
		file: targetFile,
		managedTargetUnits: managedTargetCount,
		sourceUnits: sourceUnitCount,
		orphaned: orphanCandidates,
		note: "Kept the translations and marked them need:verify-deletion. If the source is broken (unclosed code fence, sync.level change), fix it and sync again — the units recover automatically.",
	});
	return { policy: "verify", withheld: true };
}

/**
 * 廃止された need 語彙を新モデルへ正規化する（決定的・冪等・AI不使用）。
 * - need:keep → need除去（fromなしの素hashマーカー＝独立ユニットとして意味的に等価）
 * - need:backfill → need:review（原文側プレースホルダの整備/削除を人間の判断に委ねる）
 * @param units ユニットの配列（source/target 両方に適用する）
 */
export function normalizeLegacyNeeds(units: MdaitUnit[]): void {
	for (const unit of units) {
		if (!unit.marker) continue;
		if (unit.marker.need === "keep") {
			unit.marker.removeNeedTag();
		} else if (unit.marker.need === "backfill") {
			unit.marker.setNeed("review");
		}
	}
}

/**
 * ユニットにmdaitマーカーを付与する
 * @param units ユニットの配列
 */
function ensureMdaitMarkerHash(units: MdaitUnit[]) {
	for (const unit of units) {
		if (!unit.marker || !unit.marker.hash) {
			const hash = calculateHash(unit.content);
			unit.marker = new MdaitMarker(hash);
		}
	}
}

/**
 * frontmatterマーカーを同期する（テスト用にエクスポート）
 * @deprecated sync-frontmatter.ts から直接importしてください
 */
export { syncFrontmatterMarkers } from "./sync-frontmatter";

/**
 * ユニットのハッシュを更新する
 * @param matchResult ユニットのマッチ結果
 * @param adopt adoptモード（マーカーなし既訳を need:review で採用）
 * @returns need:revise付与件数とadopt採用件数
 */
function updateSectionHashes(
	matchResult: { source: MdaitUnit | null; target: MdaitUnit | null }[],
	config: Configuration,
	sourceFilePath: string,
	targetFilePath: string,
	adopt = false,
): { revisionsNeeded: number; adopted: number; noteMigrations: Array<{ from: string; to: string }> } {
	let revisionsNeeded = 0;
	let adopted = 0;
	// 本文編集で hash が変わったユニットは、紐づく note を旧→新 hash へ移送する（unit-registry）。
	// content は content-addressed で不変。note だけがユニットに追従する（決定的・AI 不使用）。
	const noteMigrations: Array<{ from: string; to: string }> = [];
	const recordMigration = (oldHash: string | null | undefined, newHash: string): void => {
		if (oldHash && oldHash !== newHash) {
			noteMigrations.push({ from: oldHash, to: newHash });
		}
	};
	for (const pair of matchResult) {
		const source = pair.source;
		const target = pair.target;

		// sourceとtargetが存在 : 通常の同期処理
		if (source && target) {
			// 原文が戻ってきたので「削除してよいか確認して」の前提が消えた。ここで解除しないと、
			// パースの崩れが直ったあとも全ユニットが verify-deletion のまま残る（実測）。
			if (target.marker?.need === "verify-deletion") {
				target.marker.removeNeedTag();
			}
			const sourceHash = calculateHash(source.content);
			const targetHash = calculateHash(target.content);
			recordMigration(source.marker?.hash, sourceHash);
			recordMigration(target.marker?.hash, targetHash);

			// adopt判定: from未確立かつ本文のある既存targetのみが採用候補
			const hadFrom = !!target.marker?.from;
			const adoptTarget = adopt && !hadFrom && target.content.trim() !== "";

			// ペアのどちらか一方が isolate の場合は need を凍結する（hash/from のみ最新化し、
			// 新しい翻訳需要を流さない。target 側 isolate は revise による isolate 上書きも防ぐ）
			const suppressNeed = source.marker?.need === "isolate" || target.marker?.need === "isolate";

			// 共通ロジックを使用してペア同期
			const result = syncMarkerPair(
				sourceHash,
				targetHash,
				source.marker,
				target.marker,
				{ adoptTarget, suppressNeed },
			);
			source.marker = result.sourceMarker;
			target.marker = result.targetMarker;
			if (result.targetMarker.needsRevision()) {
				revisionsNeeded++;
			}
			if (adoptTarget && result.targetMarker.need === "review") {
				adopted++;
			}
			continue;
		}

		// sourceのみ存在: 孤立sourceの処理
		if (source && !target) {
			const sourceHash = calculateHash(source.content);
			recordMigration(source.marker?.hash, sourceHash);
			const result = syncSourceMarker(sourceHash, source.marker);
			source.marker = result.marker;
			continue;
		}

		// targetのみ存在: 孤立targetの処理
		// 独立ユニットもハッシュのみ最新化する（syncSourceMarkerはneed/fromに触れない）
		if (!source && target) {
			const targetHash = calculateHash(target.content);
			recordMigration(target.marker?.hash, targetHash);
			const result = syncSourceMarker(targetHash, target.marker);
			target.marker = result.marker;
		}
	}
	return { revisionsNeeded, adopted, noteMigrations };
}

/**
 * ユニットレジストリのGC処理
 * StatusItemTreeから全ユニットのハッシュを収集し、不要なユニットレジストリを削除
 * @param statusManager StatusManagerインスタンス
 */
async function runUnitRegistryGC(statusManager: StatusManager): Promise<void> {
	const unitRegistryManager = UnitRegistryManager.getInstance();

	// ファイルサイズが閾値未満ならスキップ（GC内部でもチェックされるが、hash収集コストを削減）
	if (unitRegistryManager.getUnitRegistryFileSize() < 5 * 1024 * 1024) {
		return;
	}

	// 全StatusItemから使用中のhashを収集
	const activeHashes = new Set<string>();
	const tree = statusManager.getStatusItemTree();
	const files = tree.getFilesAll();

	for (const file of files) {
		for (const unit of file.children ?? []) {
			if (unit.unitHash) {
				activeHashes.add(unit.unitHash);
			}
			if (unit.fromHash) {
				activeHashes.add(unit.fromHash);
			}
			// need:revise@{oldhash}形式からoldhashを抽出
			const oldhash = MdaitMarker.extractOldHashFromNeed(unit.needFlag);
			if (oldhash) {
				activeHashes.add(oldhash);
			}
		}
	}

	await unitRegistryManager.garbageCollect(activeHashes);
}
