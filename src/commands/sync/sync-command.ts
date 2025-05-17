import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { Configuration } from "../../config/configuration";
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

		// 設定を検証
		const validationError = config.validate();
		if (validationError) {
			vscode.window.showErrorMessage(`設定エラー: ${validationError}`);
			return;
		}

		// ファイル探索
		const fileExplorer = new FileExplorer();
		const files = await fileExplorer.getSourceFiles(config);

		if (files.length === 0) {
			vscode.window.showWarningMessage(
				"同期対象のファイルが見つかりませんでした。",
			);
			return;
		}

		vscode.window.showInformationMessage(
			`${files.length}個のファイルを同期します...`,
		);

		// 各ファイルを同期
		let successCount = 0;
		let errorCount = 0;

		// セクション同期処理のインスタンス
		const sectionMatcher = new SectionMatcher();
		const diffDetector = new DiffDetector();

		for (const sourceFile of files) {
			try {
				// ファイル読み込み
				const sourceContent = fs.readFileSync(sourceFile, "utf-8");

				// 出力先パスを取得
				const targetFile = fileExplorer.getTargetPath(sourceFile, config);
				let targetContent = "";

				// ターゲットファイルが存在するか確認
				if (fs.existsSync(targetFile)) {
					targetContent = fs.readFileSync(targetFile, "utf-8");
				}

				// ファイルタイプに応じて適切な同期処理を選択
				const extension = path.extname(sourceFile).toLowerCase();

				if (extension === ".md") {
					// Markdownのセクション分割
					const source = markdownParser.parse(sourceContent);
					const target = targetContent
						? markdownParser.parse(targetContent)
						: { sections: [] };

					// セクションの対応付け
					const matchResult = sectionMatcher.match(
						source.sections,
						target.sections,
					);

					// 同期結果の生成
					const syncedSections = sectionMatcher.createSyncedTargets(
						matchResult,
						true, // auto-delete (設定から取得するようにする予定)
					);

					// 差分検出
					const diffResult = diffDetector.detect(
						target.sections,
						syncedSections,
					);

					// 同期結果をMarkdownオブジェクトとして構築
					const syncedDoc = {
						frontMatter: target.frontMatter,
						sections: syncedSections,
					};

					// 同期結果を文字列に変換
					const syncedContent = markdownParser.stringify(syncedDoc);

					// 出力先ディレクトリが存在するか確認し、なければ作成
					fileExplorer.ensureTargetDirectoryExists(targetFile);

					// ファイル出力
					fs.writeFileSync(targetFile, syncedContent, "utf-8");

					// ログ出力
					console.log(`File: ${path.basename(sourceFile)}`);
					console.log(`  Added: ${diffResult.added}`);
					console.log(`  Modified: ${diffResult.modified}`);
					console.log(`  Deleted: ${diffResult.deleted}`);
					console.log(`  Unchanged: ${diffResult.unchanged}`);
				} else {
					// Markdown以外は現時点ではそのままコピー
					fileExplorer.ensureTargetDirectoryExists(targetFile);
					fs.writeFileSync(targetFile, sourceContent, "utf-8");
				}

				successCount++;
			} catch (error) {
				console.error(`ファイル同期エラー: ${sourceFile}`, error);
				errorCount++;
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
