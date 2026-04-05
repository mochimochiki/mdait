import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { FileStateStore } from "../../core/file-state/file-state-store";
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
import { SelectionState } from "../../core/status/selection-state";
import { StatusManager } from "../../core/status/status-manager";
import { UnitRegistryManager } from "../../core/unit-registry/unit-registry-manager";
import type { TransPair } from "../../infra/config/configuration";
import { Configuration } from "../../infra/config/configuration";
import { Logger, formatError } from "../../infra/logging/logger";
import { FileExplorer } from "../../infra/workspace/file-explorer";
import { ensureMdaitDir } from "../../infra/workspace/mdait-dir";
import type { FileSyncResult } from "../file-handler/file-handler";
import { getFileHandler } from "../file-handler/file-handler-factory";
import { DiffDetector, type DiffResult, DiffType } from "./diff-detector";
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
	durationMs: number;
}

/**
 * sync command
 * Markdownユニットの同期を行う
 */
export async function syncCommand(): Promise<SyncResult | undefined> {
	const startTime = Date.now();
	try {
		// 準備
		const statusManager = StatusManager.getInstance();
		const config = Configuration.getInstance();
		const validationError = config.validate();
		if (validationError) {
			vscode.window.showErrorMessage(
				vscode.l10n.t("Configuration error: {0}", validationError),
			);
			return;
		}

		const pairs = SelectionState.getInstance().filterTransPairs(
			config.transPairs,
		);
		logger.info("sync", "Sync started", {
			pairCount: pairs.length,
		});

		let successCount = 0;
		let errorCount = 0;
		let totalFileCount = 0;
		let totalAdded = 0;
		let totalModified = 0;
		let totalDeleted = 0;
		let totalUnchanged = 0;
		let totalRevisionsNeeded = 0;

		// FileStateStoreをロード
		const mdaitDir = await ensureMdaitDir();
		if (mdaitDir) {
			FileStateStore.getInstance().load(mdaitDir);
		}

		// orphanクリーンアップ用: 全pairの有効ターゲットパスを収集
		const validTargetPaths = new Set<string>();

		// TransPairごとに処理
		for (const pair of pairs) {
			// ソースファイル一覧を取得（extensions対応）
			const fileExplorer = new FileExplorer();
			const files = await fileExplorer.getSourceFiles(
				pair.sourceDir,
				config,
				pair.extensions,
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

			// 有効ターゲットパスを収集（非MDファイルのorphanクリーンアップ用）
			for (const file of files) {
				if (path.extname(file).toLowerCase() !== ".md") {
					const tgt = fileExplorer.getTargetPath(file, pair);
					if (tgt) {
						validTargetPaths.add(fileExplorer.normalizePath(tgt));
					}
				}
			}

			// CPUコア数に基づく並列処理制限
			const parallelCpuLimit = Math.max(1, Math.min(os.cpus()?.length ?? 4, 8));
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
						const handler = getFileHandler(sourceFile);
						let syncResult: FileSyncResult;
						const isExistingTarget = fs.existsSync(targetFile);
						if (isExistingTarget) {
							syncResult = await handler.sync(sourceFile, targetFile);
						} else {
							syncResult = await handler.syncNew(sourceFile, targetFile);
						}

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
				{ length: Math.min(parallelCpuLimit, files.length) },
				() => worker(),
			);
			await Promise.all(workers);

			// スナップショットバッファをフラッシュ
			const unitRegistryManager = UnitRegistryManager.getInstance();
			await unitRegistryManager.flushBuffer();
		}

		// FileStateStoreのorphanクリーンアップ＋保存
		if (mdaitDir) {
			const fileStateStore = FileStateStore.getInstance();
			const orphansRemoved = fileStateStore.cleanupOrphans(validTargetPaths);
			if (orphansRemoved > 0) {
				logger.info("sync", "Cleaned up orphan file-state entries", {
					orphansRemoved,
				});
			}
			fileStateStore.save(mdaitDir);
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
			durationMs,
		});

		vscode.window.showInformationMessage(
			vscode.l10n.t(
				"Synchronization completed: {0} succeeded, {1} failed",
				successCount,
				errorCount,
			),
		);

		return {
			totalFileCount,
			successCount,
			errorCount,
			totalAdded,
			totalModified,
			totalDeleted,
			totalUnchanged,
			revisionsNeeded: totalRevisionsNeeded,
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

		// FileStateStoreの遅延ロード（非MDファイル対応）
		const handler = getFileHandler(sourceFile);
		if (handler.fileType === "plain") {
			const mdaitDir = await ensureMdaitDir();
			if (mdaitDir) {
				FileStateStore.getInstance().ensureLoaded(mdaitDir);
			}
		}

		// FileHandlerを使って同期処理を実行
		let syncResult: FileSyncResult;
		const isExistingFile = fs.existsSync(targetFile);
		if (isExistingFile) {
			syncResult = await handler.sync(sourceFile, targetFile);
		} else {
			syncResult = await handler.syncNew(sourceFile, targetFile);
		}

		// スナップショットバッファをフラッシュ
		await unitRegistryManager.flushBuffer();

		// 非MDファイルの場合はFileStateStoreを保存
		if (handler.fileType === "plain") {
			const mdaitDir = await ensureMdaitDir();
			if (mdaitDir) {
				FileStateStore.getInstance().save(mdaitDir);
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
	const source = markdownParser.parse(sourceContent, config);

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

	// 3. target用ユニットを生成（from:hash, need:translateを付与）
	const targetUnits = source.units.map((srcUnit) => {
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
	const targetContent = markdownParser.stringify(targetDoc);
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
	const updatedSourceContent = markdownParser.stringify({
		frontMatter: frontmatterSync.sourceFrontMatter ?? source.frontMatter,
		units: source.units,
	});
	await vscode.workspace.fs.writeFile(
		vscode.Uri.file(sourceFile),
		encoder.encode(updatedSourceContent),
	);

	// 6. DiffResultを返す
	return {
		diffs: source.units.map((u) => ({
			type: DiffType.ADDED,
			source: u,
			target: null,
		})),
		added: source.units.length,
		modified: 0,
		deleted: 0,
		unchanged: 0,
	};
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
): Promise<DiffResult> {
	const sectionMatcher = new SectionMatcher();
	const diffDetector = new DiffDetector();
	const fileExplorer = new FileExplorer();

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

	// Markdownのユニット分割
	const source = markdownParser.parse(sourceContent, config);
	const target = markdownParser.parse(targetContent, config);

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

	// ユニットの対応付け
	const matchResult = sectionMatcher.match(source.units, target.units);

	// ユニットのハッシュを更新
	const revisionsNeeded = updateSectionHashes(
		matchResult,
		config,
		sourceFile,
		targetFile,
	);

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

	// 同期結果の生成
	const syncedUnits = sectionMatcher.createSyncedTargets(
		matchResult,
		true, // auto-delete (設定から取得するようにする予定)
	);

	// 差分検出
	const diffResult = diffDetector.detect(target.units, syncedUnits);
	diffResult.revisionsNeeded = revisionsNeeded;

	// 同期結果をMarkdownオブジェクトとして構築
	const syncedDoc = {
		frontMatter: frontmatterSync.targetFrontMatter ?? target.frontMatter,
		units: syncedUnits,
	};

	// 同期結果を文字列に変換
	const syncedContent = markdownParser.stringify(syncedDoc);

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
	const updatedSourceContent = markdownParser.stringify({
		frontMatter: frontmatterSync.sourceFrontMatter ?? source.frontMatter,
		units: source.units,
	});

	await vscode.workspace.fs.writeFile(
		vscode.Uri.file(sourceFile),
		encoder.encode(updatedSourceContent),
	);

	return diffResult;
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
 * @returns need:revise付与件数
 */
function updateSectionHashes(
	matchResult: { source: MdaitUnit | null; target: MdaitUnit | null }[],
	config: Configuration,
	sourceFilePath: string,
	targetFilePath: string,
): number {
	let revisionsNeeded = 0;
	for (const pair of matchResult) {
		const source = pair.source;
		const target = pair.target;

		// sourceとtargetが存在 : 通常の同期処理
		if (source && target) {
			const sourceHash = calculateHash(source.content);
			const targetHash = calculateHash(target.content);

			// 共通ロジックを使用してペア同期
			const result = syncMarkerPair(
				sourceHash,
				targetHash,
				source.marker,
				target.marker,
			);
			source.marker = result.sourceMarker;
			target.marker = result.targetMarker;
			if (result.targetMarker.needsRevision()) {
				revisionsNeeded++;
			}
			continue;
		}

		// sourceのみ存在: 孤立sourceの処理
		if (source && !target) {
			const sourceHash = calculateHash(source.content);
			const result = syncSourceMarker(sourceHash, source.marker);
			source.marker = result.marker;
			continue;
		}

		// targetのみ存在: 孤立targetの処理
		if (!source && target) {
			const targetHash = calculateHash(target.content);
			const result = syncSourceMarker(targetHash, target.marker);
			target.marker = result.marker;
		}
	}
	return revisionsNeeded;
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
