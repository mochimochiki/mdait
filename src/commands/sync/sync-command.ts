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
 * Markdownセクションの同期を行う
 */
export async function syncCommand(): Promise<void> {
	try {
		// 処理開始を通知
		vscode.window.showInformationMessage("セクション同期処理を開始します...");

		// 設定を読み込む
		const config = new Configuration();
		await config.load();
		console.log(`Loaded configuration: ${JSON.stringify(config)}`);

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
						const diffResult = syncMarkdownFile(sourceFile, targetFile);

						// ログ出力
						console.log(`File: ${path.basename(sourceFile)}`);
						console.log(`  Added: ${diffResult.added}`);
						console.log(`  Modified: ${diffResult.modified}`);
						console.log(`  Deleted: ${diffResult.deleted}`);
						console.log(`  Unchanged: ${diffResult.unchanged}`);
					} else {
						// Markdown以外はそのままコピー
						syncNonMarkdownFile(sourceFile, targetFile);
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
 * @returns 差分検出結果
 */
function syncMarkdownFile(sourceFile: string, targetFile: string) {
	const sectionMatcher = new SectionMatcher();
	const diffDetector = new DiffDetector();
	const fileExplorer = new FileExplorer();

	// ファイル読み込み
	const sourceContent = fs.readFileSync(sourceFile, "utf-8");
	let targetContent = "";
	if (fs.existsSync(targetFile)) {
		targetContent = fs.readFileSync(targetFile, "utf-8");
	}

	// Markdownのセクション分割
	const source = markdownParser.parse(sourceContent);
	const target = targetContent
		? markdownParser.parse(targetContent)
		: { sections: [] };

	// src, target に hash を付与（ない場合のみ）
	ensureSectionHash(source.sections);
	ensureSectionHash(target.sections);

	// セクションの対応付け
	const matchResult = sectionMatcher.match(source.sections, target.sections);

	// セクションのハッシュを更新
	updateSectionHashes(matchResult);

	// 同期結果の生成
	const syncedSections = sectionMatcher.createSyncedTargets(
		matchResult,
		true, // auto-delete (設定から取得するようにする予定)
	);

	// 差分検出
	const diffResult = diffDetector.detect(target.sections, syncedSections);

	// 同期結果をMarkdownオブジェクトとして構築
	const syncedDoc = {
		frontMatter: target.frontMatter,
		frontMatterRaw: target.frontMatterRaw,
		sections: syncedSections,
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
		sections: source.sections,
	});
	fs.writeFileSync(sourceFile, updatedSourceContent, "utf-8");

	return diffResult;
}

/**
 * Markdown以外のファイルの同期処理を行う
 * @param sourceFile ソースファイルのパス
 * @param targetFile ターゲットファイルのパス
 */
function syncNonMarkdownFile(sourceFile: string, targetFile: string): void {
	// ファイル読み込み
	const sourceContent = fs.readFileSync(sourceFile, "utf-8");

	// ファイルエクスプローラーインスタンス生成
	const fileExplorer = new FileExplorer();

	// Markdown以外は現時点ではそのままコピー
	fileExplorer.ensureTargetDirectoryExists(targetFile);
	fs.writeFileSync(targetFile, sourceContent, "utf-8");
}

/**
 * セクションにmdaitヘッダーを付与する
 * @param sections セクションの配列
 */
function ensureSectionHash(sections: MdaitUnit[]) {
	for (const unit of sections) {
		if (!unit.marker || !unit.marker.hash) {
			const hash = calculateHash(unit.content);
			unit.marker = new MdaitMarker(hash);
		}
	}
}

/**
 * セクションのハッシュを更新する
 * @param matchResult セクションのマッチ結果
 */
function updateSectionHashes(
	matchResult: { source: MdaitUnit | null; target: MdaitUnit | null }[],
) {
	for (const pair of matchResult) {
		if (pair.source) {
			const newHash = calculateHash(pair.source.content);
			if (!pair.source.marker) {
				pair.source.marker = new MdaitMarker(newHash);
			} else if (pair.source.marker.hash !== newHash) {
				pair.source.marker.hash = newHash;
			}
		}
		if (pair.source && pair.target) {
			// targetのfrom/hashも最新化
			const fromHash = calculateHash(pair.source.content);
			if (!pair.target.marker) {
				pair.target.marker = new MdaitMarker(
					calculateHash(pair.target.content),
					fromHash,
				);
			} else {
				// hashはtargetの内容で、fromのみsourceの新しいhash
				pair.target.marker.hash = calculateHash(pair.target.content);
				pair.target.marker.from = fromHash;
			}
		}
		if (pair.source && !pair.target) {
			// 新規挿入時のsourceのhashは既に上で最新化済み
		}
		if (!pair.source && pair.target) {
			// 孤立targetもhashはtarget内容で最新化
			const hash = calculateHash(pair.target.content);
			if (!pair.target.marker) {
				pair.target.marker = new MdaitMarker(hash);
			} else if (pair.target.marker.hash !== hash) {
				pair.target.marker.hash = hash;
			}
		}
	}
}
