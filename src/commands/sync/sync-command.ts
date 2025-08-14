import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { Configuration } from "../../config/configuration";
import { calculateHash } from "../../core/hash/hash-calculator";
import { MdaitMarker } from "../../core/markdown/mdait-marker";
import type { MdaitUnit } from "../../core/markdown/mdait-unit";
import { markdownParser } from "../../core/markdown/parser";
import { SelectionState } from "../../core/status/selection-state";
import { StatusManager } from "../../core/status/status-manager";
import { FileExplorer } from "../../utils/file-explorer";
import { DiffDetector, type DiffResult, DiffType } from "./diff-detector";
import { SectionMatcher } from "./section-matcher";

/**
 * sync command
 * Markdownユニットの同期を行う
 */
export async function syncCommand(): Promise<void> {
	const statusManager = StatusManager.getInstance();

	try {
		// 設定を取得
		const config = Configuration.getInstance();

		// 設定を検証
		const validationError = config.validate();
		if (validationError) {
			vscode.window.showErrorMessage(vscode.l10n.t("Configuration error: {0}", validationError));
			return;
		}

		let successCount = 0;
		let errorCount = 0;

		// 対象選択された翻訳ペアのみ処理
		const pairs = SelectionState.getInstance().filterTransPairs(config.transPairs);
		for (const pair of pairs) {
			// ファイル探索
			const fileExplorer = new FileExplorer();
			const files = await fileExplorer.getSourceFiles(pair.sourceDir, config);
			if (files.length === 0) {
				vscode.window.showWarningMessage(
					vscode.l10n.t("[{0} -> {1}] No files found for synchronization.", pair.sourceDir, pair.targetDir),
				);
				continue;
			}

			// 各ファイルを同期（Markdownのみを非同期並列実行、同時実行数を制限）
			const mdFiles = files.filter((f) => path.extname(f).toLowerCase() === ".md");

			const concurrency = Math.max(1, Math.min(os.cpus()?.length ?? 4, 8));
			let index = 0;

			const worker = async () => {
				while (true) {
					const i = index++;
					if (i >= mdFiles.length) break;
					const sourceFile = mdFiles[i];
					try {
						// 出力先パスを取得（新しい統合されたFileExplorerを使用）
						const targetFile = fileExplorer.getTargetPath(sourceFile, pair);
						if (!targetFile) {
							console.warn(`Target path could not be determined for: ${sourceFile}`);
							continue;
						}

						// Markdownファイルの同期を実行
						const diffResult = await syncMarkdownFile(sourceFile, targetFile, config);

						// ログ出力（差分情報を一行で表示）
						console.log(
							`[${pair.sourceDir} -> ${pair.targetDir}] ${path.basename(sourceFile)}: +${diffResult.added} ~${diffResult.modified} -${diffResult.deleted} =${diffResult.unchanged}`,
						);

						successCount++;
					} catch (error) {
						console.error(`[${pair.sourceDir} -> ${pair.targetDir}] ファイル同期エラー: ${sourceFile}`, error);
						// エラー時もStatusManagerに通知
						await statusManager.changeFileStatusWithError(sourceFile, error as Error);
						errorCount++;
					}
				}
			};

			const workers = Array.from({ length: Math.min(concurrency, mdFiles.length) }, () => worker());
			await Promise.all(workers);
		}
		// 完了通知
		vscode.window.showInformationMessage(
			vscode.l10n.t("Synchronization completed: {0} succeeded, {1} failed", successCount, errorCount),
		);

		// インデックスファイル生成は廃止（StatusItemベースの管理に移行）
		try {
			const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			if (workspaceRoot) {
				console.log("Sync completed - StatusItem based management");
			}
		} catch (indexError) {
			console.warn("Failed to complete sync:", indexError);
			vscode.window.showWarningMessage(vscode.l10n.t("Sync completion failed: {0}", (indexError as Error).message));
		}
	} catch (error) {
		// エラーハンドリング
		vscode.window.showErrorMessage(
			vscode.l10n.t("An error occurred during synchronization: {0}", (error as Error).message),
		);
		console.error(error);
	}
}

/**
 * Markdownファイルの同期処理を行う
 * Targetファイルが存在する場合は更新、存在しない場合は新規作成を行う
 * @param sourceFile ソースファイルのパス
 * @param targetFile ターゲットファイルのパス
 * @param config 設定
 * @returns 差分検出結果
 */
async function syncMarkdownFile(sourceFile: string, targetFile: string, config: Configuration): Promise<DiffResult> {
	if (fs.existsSync(targetFile)) {
		return syncExistingMarkdownFile(sourceFile, targetFile, config);
	}
	return await createInitialTargetFile(sourceFile, targetFile, config);
}

/**
 * 新規にターゲットファイルを作成する
 * @param sourceFile ソースファイルのパス
 * @param targetFile ターゲットファイルのパス
 * @param config 設定
 * @returns 差分検出結果
 */
async function createInitialTargetFile(
	sourceFile: string,
	targetFile: string,
	config: Configuration,
): Promise<DiffResult> {
	const fileExplorer = new FileExplorer();

	// 1. ソースファイル読み込み＆パース
	const document = await vscode.workspace.fs.readFile(vscode.Uri.file(sourceFile));
	const decoder = new TextDecoder("utf-8");
	const sourceContent = decoder.decode(document);
	const source = markdownParser.parse(sourceContent, config);

	// 2. mdaitマーカーとハッシュを付与（source側はneed,fromなし）
	ensureMdaitMarkerHash(source.units);

	// 3. target用ユニットを生成（from:hash, need:translateを付与）
	const targetUnits = source.units.map((srcUnit) => {
		const hash = srcUnit.marker?.hash ?? calculateHash(srcUnit.content);
		const tgtMarker = new MdaitMarker(hash, hash, "translate");
		const tgtUnit = Object.create(Object.getPrototypeOf(srcUnit));
		Object.assign(tgtUnit, srcUnit, { marker: tgtMarker });
		return tgtUnit;
	});
	const targetDoc = {
		frontMatter: source.frontMatter,
		frontMatterRaw: source.frontMatterRaw,
		units: targetUnits,
	};

	// 4. ターゲットファイルとして保存
	const encoder = new TextEncoder();
	const targetContent = markdownParser.stringify(targetDoc);
	fileExplorer.ensureTargetDirectoryExists(targetFile);
	await vscode.workspace.fs.writeFile(vscode.Uri.file(targetFile), encoder.encode(targetContent));

	// 5. ソースファイルもマーカー付きで更新（need,fromは付与しない）
	const updatedSourceContent = markdownParser.stringify(source);
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
 * 既存のターゲットファイルを同期する
 * @param sourceFile ソースファイルのパス
 * @param targetFile ターゲットファイルのパス
 * @param config 設定
 * @returns 差分検出結果
 */
async function syncExistingMarkdownFile(
	sourceFile: string,
	targetFile: string,
	config: Configuration,
): Promise<DiffResult> {
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
	// src, target に hash を付与（ない場合のみ）
	ensureMdaitMarkerHash(source.units);
	ensureMdaitMarkerHash(target.units);

	// ユニットの対応付け
	const matchResult = sectionMatcher.match(source.units, target.units);

	// ユニットのハッシュを更新
	updateSectionHashes(matchResult, config, sourceFile, targetFile);

	// 同期結果の生成
	const syncedUnits = sectionMatcher.createSyncedTargets(
		matchResult,
		true, // auto-delete (設定から取得するようにする予定)
	);

	// 差分検出
	const diffResult = diffDetector.detect(target.units, syncedUnits);

	// 同期結果をMarkdownオブジェクトとして構築
	const syncedDoc = {
		frontMatter: target.frontMatter,
		frontMatterRaw: target.frontMatterRaw,
		units: syncedUnits,
	};

	// 同期結果を文字列に変換
	const syncedContent = markdownParser.stringify(syncedDoc);

	// 出力先ディレクトリが存在するか確認し、なければ作成
	fileExplorer.ensureTargetDirectoryExists(targetFile);

	// ファイル出力
	const encoder = new TextEncoder();
	await vscode.workspace.fs.writeFile(vscode.Uri.file(targetFile), encoder.encode(syncedContent));

	// source側にもmdaitヘッダー・hashを必ず付与・更新し、ファイル保存
	const updatedSourceContent = markdownParser.stringify({
		frontMatter: source.frontMatter,
		frontMatterRaw: source.frontMatterRaw,
		units: source.units,
	});

	await vscode.workspace.fs.writeFile(vscode.Uri.file(sourceFile), encoder.encode(updatedSourceContent));

	return diffResult;
}

/**
 * ユニットにmdaitヘッダーを付与する
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

			const sourceMarker = source.marker ?? new MdaitMarker(sourceHash);
			const targetMarker = target.marker ?? new MdaitMarker(targetHash, sourceMarker.hash);

			const isSourceChanged = sourceMarker.hash !== sourceHash;
			const isTargetChanged = targetMarker.hash !== targetHash;

			// 双方向翻訳ペアで両方変更された場合、競合フラグを立てる
			if (isSourceChanged && isTargetChanged) {
				sourceMarker.setNeed("solve-conflict");
				targetMarker.setNeed("solve-conflict");
				// ハッシュは更新しない
				source.marker = sourceMarker;
				target.marker = targetMarker;
				continue;
			}

			// source:hashを計算して付与
			if (isSourceChanged) {
				sourceMarker.hash = sourceHash;
			}
			// target:hashを計算して付与
			if (isTargetChanged) {
				targetMarker.hash = targetHash;
			}

			// ソースで変更があった場合、need:translate付与
			const oldSourceHash = targetMarker.from;
			if (oldSourceHash !== sourceMarker.hash) {
				targetMarker.from = sourceMarker.hash;
				targetMarker.setNeed("translate");
				source.marker = sourceMarker;
				target.marker = targetMarker;
				continue;
			}

			source.marker = sourceMarker;
			target.marker = targetMarker;
			continue;
		}
		// sourceのみ存在: 孤立sourceの処理
		if (source && !target) {
			// hashを計算して付与
			const sourceHash = calculateHash(source.content);
			if (!source.marker) {
				source.marker = new MdaitMarker(sourceHash);
			} else if (source.marker.hash !== sourceHash) {
				source.marker.hash = sourceHash;
			}
			continue;
		}
		// targetのみ存在: 孤立targetの処理
		if (!source && target) {
			// hashを計算して付与
			const hash = calculateHash(target.content);
			if (!target.marker) {
				target.marker = new MdaitMarker(hash);
			} else if (target.marker.hash !== hash) {
				target.marker.hash = hash;
			}
		}
	}
}
