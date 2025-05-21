import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { Configuration } from "../../config/configuration";
import { FileExplorer } from "../../utils/file-explorer";
import { DefaultTranslationProvider } from "./translation-provider";

/**
 * trans command
 * markdownの翻訳を実行する
 */
export async function transCommand(): Promise<void> {
	try {
		// 翻訳処理の開始を通知
		vscode.window.showInformationMessage("翻訳処理を開始します...");

		// 設定を読み込む
		const config = new Configuration();
		await config.load();

		// 設定を検証
		const validationError = config.validate();
		if (validationError) {
			vscode.window.showErrorMessage(`設定エラー: ${validationError}`);
			return;
		}

		// 翻訳プロバイダーを初期化
		const provider = new DefaultTranslationProvider();

		let successCount = 0;
		let errorCount = 0;

		// 各翻訳ペアに対して処理を実行
		for (const pair of config.transPairs) {
			// ファイル探索
			const fileExplorer = new FileExplorer();
			// transコマンドでは、翻訳対象ファイルはtargetDirから取得する
			const files = await fileExplorer.getSourceFiles(pair.targetDir, config);

			if (files.length === 0) {
				vscode.window.showWarningMessage(
					`[${pair.sourceDir} -> ${pair.targetDir}] 翻訳対象のファイルが見つかりませんでした。`,
				);
				continue;
			}

			vscode.window.showInformationMessage(
				`[${pair.sourceDir} -> ${pair.targetDir}] ${files.length}個のファイルを翻訳します...`,
			);

			// 各ファイルを翻訳
			for (const targetFile of files) {
				try {
					// ファイル読み込み
					const content = fs.readFileSync(targetFile, "utf-8");

					// ファイルタイプに応じて適切な翻訳処理を選択
					const extension = path.extname(targetFile).toLowerCase();
					let translatedContent: string;

					if (extension === ".md") {
						translatedContent = await provider.translateMarkdown(
							content,
							config,
						);
					} else if (extension === ".csv") {
						translatedContent = await provider.translateCsv(content, config);
					} else {
						// その他のファイルタイプはそのまま
						translatedContent = content;
					}

					// 出力先ディレクトリが存在するか確認し、なければ作成
					fileExplorer.ensureTargetDirectoryExists(targetFile);

					// ファイル出力 (transコマンドはtargetFileを上書きする)
					fs.writeFileSync(targetFile, translatedContent, "utf-8");

					successCount++;
				} catch (error) {
					console.error(
						`[${pair.sourceDir} -> ${pair.targetDir}] ファイル翻訳エラー: ${targetFile}`,
						error,
					);
					errorCount++;
				}
			}
		}

		// 完了通知
		vscode.window.showInformationMessage(
			`翻訳完了: ${successCount}個成功, ${errorCount}個失敗`,
		);
	} catch (error) {
		// エラーハンドリング
		vscode.window.showErrorMessage(
			`翻訳処理中にエラーが発生しました: ${(error as Error).message}`,
		);
		console.error(error);
	}
}
