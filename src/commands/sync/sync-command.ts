import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { Configuration } from "../../config/configuration";
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
import { SnapshotManager } from "../../core/snapshot/snapshot-manager";
import { SelectionState } from "../../core/status/selection-state";
import { StatusManager } from "../../core/status/status-manager";
import { FileExplorer } from "../../utils/file-explorer";
import { syncMarkerPair, syncSourceMarker, syncTargetMarker } from "./marker-sync";
import { DiffDetector, type DiffResult, DiffType } from "./diff-detector";
import { SectionMatcher } from "./section-matcher";

/**
 * sync command
 * Markdownユニットの同期を行う
 */
export async function syncCommand(): Promise<void> {
	try {
		// 準備
		const statusManager = StatusManager.getInstance();
		const config = Configuration.getInstance();
		const validationError = config.validate();
		if (validationError) {
			vscode.window.showErrorMessage(vscode.l10n.t("Configuration error: {0}", validationError));
			return;
		}
		let successCount = 0;
		let errorCount = 0;

		// TransPairごとに処理
		const pairs = SelectionState.getInstance().filterTransPairs(config.transPairs);
		for (const pair of pairs) {
			// Source Markdownファイル一覧を取得
			const fileExplorer = new FileExplorer();
			const files = await fileExplorer.getSourceFiles(pair.sourceDir, config);
			if (files.length === 0) {
				vscode.window.showWarningMessage(
					vscode.l10n.t("[{0} -> {1}] No files found for synchronization.", pair.sourceDir, pair.targetDir),
				);
				continue;
			}
			const sourceMdFiles = files.filter((f) => path.extname(f).toLowerCase() === ".md");

			// CPUコア数に基づく並列処理制限
			const parallelCpuLimit = Math.max(1, Math.min(os.cpus()?.length ?? 4, 8));
			let index = 0;

			// ワーカー関数（並列実行処理）
			const worker = async () => {
				while (true) {
					const i = index++;
					if (i >= sourceMdFiles.length) break;
					const sourceFile = sourceMdFiles[i];
					try {
						// TargetPathを決定
						const targetFile = fileExplorer.getTargetPath(sourceFile, pair);
						if (!targetFile) {
							console.warn(`Target path could not be determined for: ${sourceFile}`);
							continue;
						}

						// 同期を実行（中核プロセス）
						let diffResult = null;
						if (fs.existsSync(targetFile)) {
							diffResult = await sync_CoreProc(sourceFile, targetFile, config);
						} else {
							diffResult = await syncNew_CoreProc(sourceFile, targetFile, config);
						}

						// 結果をStatusManagerに反映
						console.log(
							`[${pair.sourceDir} -> ${pair.targetDir}] ${path.basename(sourceFile)}: +${diffResult.added} ~${diffResult.modified} -${diffResult.deleted} =${diffResult.unchanged}`,
						);
						await statusManager.refreshFileStatus(sourceFile);
						await statusManager.refreshFileStatus(targetFile);
						successCount++;
					} catch (error) {
						console.error(`[${pair.sourceDir} -> ${pair.targetDir}] ファイル同期エラー: ${sourceFile}`, error);
						await statusManager.changeFileStatusWithError(sourceFile, error as Error);
						errorCount++;
					}
				}
			};

			// ワーカー起動と完了待機
			const workers = Array.from({ length: Math.min(parallelCpuLimit, sourceMdFiles.length) }, () => worker());
			await Promise.all(workers);

			// スナップショットバッファをフラッシュ
			const snapshotManager = SnapshotManager.getInstance();
			await snapshotManager.flushBuffer();
		}

		// 全ファイル処理完了後、GC処理
		await runSnapshotGC(statusManager);

		vscode.window.showInformationMessage(
			vscode.l10n.t("Synchronization completed: {0} succeeded, {1} failed", successCount, errorCount),
		);
	} catch (error) {
		vscode.window.showErrorMessage(
			vscode.l10n.t("An error occurred during synchronization: {0}", (error as Error).message),
		);
		console.error(error);
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
async function syncNew_CoreProc(sourceFile: string, targetFile: string, config: Configuration): Promise<DiffResult> {
	const fileExplorer = new FileExplorer();

	// 1. ソースファイル読み込み＆パース
	const document = await vscode.workspace.fs.readFile(vscode.Uri.file(sourceFile));
	const decoder = new TextDecoder("utf-8");
	const sourceContent = decoder.decode(document);
	const source = markdownParser.parse(sourceContent, config);

	const frontmatterKeys = getFrontmatterTranslationKeys(config);
	const sourceFrontHash = calculateFrontmatterHash(source.frontMatter, frontmatterKeys);
	const shouldSyncFrontmatter = sourceFrontHash !== null;

	// フロントマターのみのファイルは、frontmatter翻訳が無効なら処理しない
	if (source.units.length === 0 && !shouldSyncFrontmatter) {
		console.log(`Skipping frontmatter-only file: ${sourceFile}`);
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
	const frontmatterSync = syncFrontmatterMarkers(source.frontMatter, undefined, frontmatterKeys);

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
	await vscode.workspace.fs.writeFile(vscode.Uri.file(targetFile), encoder.encode(targetContent));

	// 4.5. スナップショット保存（初回sync時も保存）
	const snapshotManager = SnapshotManager.getInstance();
	for (const srcUnit of source.units) {
		if (srcUnit.marker?.hash) {
			snapshotManager.saveSnapshot(srcUnit.marker.hash, srcUnit.content);
		}
	}

	// 5. ソースファイルもマーカー付きで更新（need,fromは付与しない）
	const updatedSourceContent = markdownParser.stringify({
		frontMatter: frontmatterSync.sourceFrontMatter ?? source.frontMatter,
		units: source.units,
	});
	await vscode.workspace.fs.writeFile(vscode.Uri.file(sourceFile), encoder.encode(updatedSourceContent));

	// 6. DiffResultを返す
	return {
		diffs: source.units.map((u) => ({ type: DiffType.ADDED, source: u, target: null })),
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
async function sync_CoreProc(sourceFile: string, targetFile: string, config: Configuration): Promise<DiffResult> {
	const sectionMatcher = new SectionMatcher();
	const diffDetector = new DiffDetector();
	const fileExplorer = new FileExplorer();

	// ファイル読み込み
	const decoder = new TextDecoder("utf-8");
	const sourceDoc = await vscode.workspace.fs.readFile(vscode.Uri.file(sourceFile));
	const targetDoc = await vscode.workspace.fs.readFile(vscode.Uri.file(targetFile));
	const sourceContent = decoder.decode(sourceDoc);
	const targetContent = decoder.decode(targetDoc);

	// Markdownのユニット分割
	const source = markdownParser.parse(sourceContent, config);
	const target = markdownParser.parse(targetContent, config);

	const frontmatterKeys = getFrontmatterTranslationKeys(config);
	const frontmatterSync = syncFrontmatterMarkers(source.frontMatter, target.frontMatter, frontmatterKeys);

	// フロントマターのみのファイルは、frontmatter同期が無効なら処理しない
	if (source.units.length === 0 && target.units.length === 0 && !frontmatterSync.processed) {
		console.log(`Skipping frontmatter-only file: ${sourceFile}`);
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
	updateSectionHashes(matchResult, config, sourceFile, targetFile);

	// sourceのスナップショット保存
	const snapshotManager = SnapshotManager.getInstance();
	for (const srcUnit of source.units) {
		if (srcUnit.marker?.hash) {
			snapshotManager.saveSnapshot(srcUnit.marker.hash, srcUnit.content);
		}
	}

	// 同期結果の生成
	const syncedUnits = sectionMatcher.createSyncedTargets(
		matchResult,
		true, // auto-delete (設定から取得するようにする予定)
	);

	// 差分検出
	const diffResult = diffDetector.detect(target.units, syncedUnits);

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
	await vscode.workspace.fs.writeFile(vscode.Uri.file(targetFile), encoder.encode(syncedContent));

	// source側にもmdaitマーカー・hashを必ず付与・更新し、ファイル保存
	// frontmatterSync.sourceFrontMatterにはsource側のマーカーが設定済み
	const updatedSourceContent = markdownParser.stringify({
		frontMatter: frontmatterSync.sourceFrontMatter ?? source.frontMatter,
		units: source.units,
	});

	await vscode.workspace.fs.writeFile(vscode.Uri.file(sourceFile), encoder.encode(updatedSourceContent));

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
 * @param sourceFrontMatter ソース側のfrontmatter
 * @param targetFrontMatter ターゲット側のfrontmatter
 * @param keys 翻訳対象キー一覧
 * @returns sourceFrontMatter, targetFrontMatter, processed
 */
export function syncFrontmatterMarkers(
	sourceFrontMatter: FrontMatter | undefined,
	targetFrontMatter: FrontMatter | undefined,
	keys: string[],
): { sourceFrontMatter: FrontMatter | undefined; targetFrontMatter: FrontMatter | undefined; processed: boolean } {
	if (keys.length === 0) {
		return { sourceFrontMatter, targetFrontMatter, processed: false };
	}

	const sourceHash = calculateFrontmatterHash(sourceFrontMatter, keys);
	if (!sourceHash) {
		if (targetFrontMatter && parseFrontmatterMarker(targetFrontMatter)) {
			setFrontmatterMarker(targetFrontMatter, null);
		}
		return { sourceFrontMatter, targetFrontMatter, processed: false };
	}

	// Source側にもマーカーを設定（共通ロジック使用）
	if (sourceFrontMatter) {
		const existingSourceMarker = parseFrontmatterMarker(sourceFrontMatter);
		const sourceResult = syncSourceMarker(sourceHash, existingSourceMarker);
		if (sourceResult.changed) {
			setFrontmatterMarker(sourceFrontMatter, sourceResult.marker);
		}
	}

	// ターゲット側の処理
	let workingTarget = targetFrontMatter;
	if (!workingTarget) {
		workingTarget = sourceFrontMatter?.clone() ?? FrontMatter.empty();
	}

	const targetHash = calculateFrontmatterHash(workingTarget, keys, { allowEmpty: true });
	const existingMarker = parseFrontmatterMarker(workingTarget);

	// 共通ロジックを使用してターゲットマーカーを同期
	const targetResult = syncTargetMarker({
		sourceHash,
		targetHash,
		existingMarker,
	});

	setFrontmatterMarker(workingTarget, targetResult.marker);
	return { sourceFrontMatter, targetFrontMatter: workingTarget, processed: true };
}

/**
 * ユニットのハッシュを更新する
 * @param matchResult ユニットのマッチ結果
 */
function updateSectionHashes(
	matchResult: { source: MdaitUnit | null; target: MdaitUnit | null }[],
	config: Configuration,
	sourceFilePath: string,
	targetFilePath: string,
) {
	for (const pair of matchResult) {
		const source = pair.source;
		const target = pair.target;

		// sourceとtargetが存在 : 通常の同期処理
		if (source && target) {
			const sourceHash = calculateHash(source.content);
			const targetHash = calculateHash(target.content);

			// 共通ロジックを使用してペア同期
			const result = syncMarkerPair(sourceHash, targetHash, source.marker, target.marker);
			source.marker = result.sourceMarker;
			target.marker = result.targetMarker;
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
}

/**
 * スナップショットのGC処理
 * StatusItemTreeから全ユニットのハッシュを収集し、不要なスナップショットを削除
 * @param statusManager StatusManagerインスタンス
 */
async function runSnapshotGC(statusManager: StatusManager): Promise<void> {
	const snapshotManager = SnapshotManager.getInstance();

	// ファイルサイズが閾値未満ならスキップ（GC内部でもチェックされるが、hash収集コストを削減）
	if (snapshotManager.getSnapshotFileSize() < 5 * 1024 * 1024) {
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

	await snapshotManager.garbageCollect(activeHashes);
}
