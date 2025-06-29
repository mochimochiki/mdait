import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { Configuration } from "../../config/configuration";
import { calculateHash } from "../../core/hash/hash-calculator";
import { StatusManager } from "../../core/status-manager";
import { MdaitMarker } from "../../core/markdown/mdait-marker";
import type { MdaitUnit } from "../../core/markdown/mdait-unit";
import { markdownParser } from "../../core/markdown/parser";
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
		// 設定を読み込む
		const config = new Configuration();
		await config.load();

		// 設定を検証
		const validationError = config.validate();
		if (validationError) {
			vscode.window.showErrorMessage(vscode.l10n.t("Configuration error: {0}", validationError));
			return;
		}

		let successCount = 0;
		let errorCount = 0;

		// 各翻訳ペアに対して処理を実行
		for (const pair of config.transPairs) {
			// ファイル探索
			const fileExplorer = new FileExplorer();
			const files = await fileExplorer.getSourceFiles(pair.sourceDir, config);
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

			// 各ファイルを同期
			for (const sourceFile of files) {
				try {
					// 出力先パスを取得
					const targetFile = fileExplorer.getTargetPath(sourceFile, pair.sourceDir, pair.targetDir);

					// ファイルタイプに応じて適切な同期処理を選択
					const extension = path.extname(sourceFile).toLowerCase();
					if (extension === ".md") {
						// Markdownファイルの同期を実行
						const diffResult = syncMarkdownFile(sourceFile, targetFile, config);

						// StatusManagerでファイル状態をリアルタイム更新
						await statusManager.updateFileStatus(sourceFile);
						await statusManager.updateFileStatus(targetFile);

						// ログ出力（差分情報を一行で表示）
						console.log(
							`${path.basename(sourceFile)}: +${diffResult.added} ~${
								diffResult.modified
							} -${diffResult.deleted} =${diffResult.unchanged}`,
						);
					} else {
						// Markdown以外は無視
					}

					successCount++;
				} catch (error) {
					console.error(
						`[${pair.sourceDir} -> ${pair.targetDir}] ファイル同期エラー: ${sourceFile}`,
						error,
					);
					// エラー時もStatusManagerに通知
					await statusManager.updateFileStatusWithError(sourceFile, error as Error);
					errorCount++;
				}
			}
		}
		// 完了通知
		vscode.window.showInformationMessage(
			vscode.l10n.t(
				"Synchronization completed: {0} succeeded, {1} failed",
				successCount,
				errorCount,
			),
		);

		// インデックスファイル生成は廃止（StatusItemベースの管理に移行）
		try {
			const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			if (workspaceRoot) {
				console.log("Sync completed - StatusItem based management");
			}
		} catch (indexError) {
			console.warn("Failed to complete sync:", indexError);
			vscode.window.showWarningMessage(
				vscode.l10n.t("Sync completion failed: {0}", (indexError as Error).message),
			);
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
function syncMarkdownFile(
	sourceFile: string,
	targetFile: string,
	config: Configuration,
): DiffResult {
	if (fs.existsSync(targetFile)) {
		return syncExistingMarkdownFile(sourceFile, targetFile, config);
	}
	return createInitialTargetFile(sourceFile, targetFile, config);
}

/**
 * 新規にターゲットファイルを作成する
 * @param sourceFile ソースファイルのパス
 * @param targetFile ターゲットファイルのパス
 * @param config 設定
 * @returns 差分検出結果
 */
function createInitialTargetFile(
	sourceFile: string,
	targetFile: string,
	config: Configuration,
): DiffResult {
	const fileExplorer = new FileExplorer();

	// 1. ソースファイル読み込み＆パース
	const sourceContent = fs.readFileSync(sourceFile, "utf-8");
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
	const targetContent = markdownParser.stringify(targetDoc);
	fileExplorer.ensureTargetDirectoryExists(targetFile);
	fs.writeFileSync(targetFile, targetContent, "utf-8");

	// 5. ソースファイルもマーカー付きで更新（need,fromは付与しない）
	const updatedSourceContent = markdownParser.stringify(source);
	fs.writeFileSync(sourceFile, updatedSourceContent, "utf-8");

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
function syncExistingMarkdownFile(
	sourceFile: string,
	targetFile: string,
	config: Configuration,
): DiffResult {
	const sectionMatcher = new SectionMatcher();
	const diffDetector = new DiffDetector();
	const fileExplorer = new FileExplorer();

	// ファイル読み込み
	const sourceContent = fs.readFileSync(sourceFile, "utf-8");
	const targetContent = fs.readFileSync(targetFile, "utf-8");

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
	fs.writeFileSync(targetFile, syncedContent, "utf-8");

	// source側にもmdaitヘッダー・hashを必ず付与・更新し、ファイル保存
	const updatedSourceContent = markdownParser.stringify({
		frontMatter: source.frontMatter,
		frontMatterRaw: source.frontMatterRaw,
		units: source.units,
	});
	fs.writeFileSync(sourceFile, updatedSourceContent, "utf-8");

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
