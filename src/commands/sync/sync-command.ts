import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { Configuration } from "../../config/configuration";
import { calculateHash } from "../../core/hash/hash-calculator";
import { MdaitMarker } from "../../core/markdown/mdait-marker";
import type { MdaitUnit } from "../../core/markdown/mdait-unit";
import { markdownParser } from "../../core/markdown/parser";
import { FileExplorer } from "../../utils/file-explorer";
import { DiffDetector } from "./diff-detector";
import { SectionMatcher } from "./section-matcher";

/**
 * sync command
 * Markdownユニットの同期を行う
 */
export async function syncCommand(): Promise<void> {
	try {
		// 処理開始を通知
		vscode.window.showInformationMessage("ユニット同期処理を開始します...");

		// 設定を読み込む
		const config = new Configuration();
		await config.load();

		// 設定を検証
		const validationError = config.validate();
		if (validationError) {
			vscode.window.showErrorMessage(`設定エラー: ${validationError}`);
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
					`[${pair.sourceDir} -> ${pair.targetDir}] 同期対象のファイルが見つかりませんでした。`,
				);
				continue;
			}

			vscode.window.showInformationMessage(
				`[${pair.sourceDir} -> ${pair.targetDir}] ${files.length}個のファイルを同期します...`,
			);

			// 各ファイルを同期
			for (const sourceFile of files) {
				try {
					// 出力先パスを取得
					const targetFile = fileExplorer.getTargetPath(
						sourceFile,
						pair.sourceDir,
						pair.targetDir,
					);

					// ファイルタイプに応じて適切な同期処理を選択
					const extension = path.extname(sourceFile).toLowerCase();
					if (extension === ".md") {
						// Markdownファイルの同期を実行
						const diffResult = syncMarkdownFile(sourceFile, targetFile, config);

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
					errorCount++;
				}
			}
		}

		// 完了通知
		vscode.window.showInformationMessage(
			`同期完了: ${successCount}個成功, ${errorCount}個失敗`,
		);
	} catch (error) {
		// エラーハンドリング
		vscode.window.showErrorMessage(
			`同期処理中にエラーが発生しました: ${(error as Error).message}`,
		);
		console.error(error);
	}
}

/**
 * Markdownファイルの同期処理を行う
 * @param sourceFile ソースファイルのパス
 * @param targetFile ターゲットファイルのパス
 * @param config 設定
 * @returns 差分検出結果
 */
function syncMarkdownFile(
	sourceFile: string,
	targetFile: string,
	config: Configuration,
) {
	const sectionMatcher = new SectionMatcher();
	const diffDetector = new DiffDetector();
	const fileExplorer = new FileExplorer();

	// ファイル読み込み
	const sourceContent = fs.readFileSync(sourceFile, "utf-8");
	let targetContent = "";
	if (fs.existsSync(targetFile)) {
		targetContent = fs.readFileSync(targetFile, "utf-8");
	}

	// Markdownのユニット分割
	const source = markdownParser.parse(sourceContent, config);
	const target = targetContent
		? markdownParser.parse(targetContent, config)
		: { units: [] };
	// src, target に hash を付与（ない場合のみ）
	ensureSectionHash(source.units);
	ensureSectionHash(target.units);

	// ユニットの対応付け
	const matchResult = sectionMatcher.match(source.units, target.units);

	// ユニットのハッシュを更新
	updateSectionHashes(matchResult);

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
function ensureSectionHash(units: MdaitUnit[]) {
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
) {
	for (const pair of matchResult) {
		const source = pair.source;
		const target = pair.target;

		// sourceとtargetが存在 : 通常の同期処理
		if (source && target) {
			// source:hashを計算して付与
			const sourceHash = calculateHash(source.content);
			if (!source.marker) {
				source.marker = new MdaitMarker(sourceHash);
			} else if (source.marker.hash !== sourceHash) {
				source.marker.hash = sourceHash;
			}
			// target:hashを計算して付与
			const targetHash = calculateHash(target.content);
			if (!target.marker) {
				target.marker = new MdaitMarker(targetHash, sourceHash);
			} else {
				target.marker.hash = targetHash;
				// need:translate付与(ソース側の変更があった場合)
				const oldFromHash = target.marker.from;
				if (oldFromHash !== sourceHash) {
					target.marker.from = sourceHash;
					target.marker.need = "translate";
				}
			}
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
