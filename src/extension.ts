import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { Configuration } from "./config/configuration";
import { FileExplorer } from "./utils/file-explorer";
import { DefaultTranslationProvider } from "./commands/translate/translation-provider";

export function activate(context: vscode.ExtensionContext) {
  console.log('Congratulations, your extension "mdtrans" is now active!');

  // 翻訳コマンドを追加
  const translateDisposable = vscode.commands.registerCommand(
    "mdtrans.translate",
    async () => {
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

        // ファイル探索
        const fileExplorer = new FileExplorer();
        const files = await fileExplorer.getSourceFiles(config);

        if (files.length === 0) {
          vscode.window.showWarningMessage(
            "翻訳対象のファイルが見つかりませんでした。"
          );
          return;
        }

        vscode.window.showInformationMessage(
          `${files.length}個のファイルを翻訳します...`
        );

        // 翻訳プロバイダーを初期化
        const provider = new DefaultTranslationProvider();

        // 各ファイルを翻訳
        let successCount = 0;
        let errorCount = 0;

        for (const sourceFile of files) {
          try {
            // ファイル読み込み
            const content = fs.readFileSync(sourceFile, "utf-8");

            // ファイルタイプに応じて適切な翻訳処理を選択
            const extension = path.extname(sourceFile).toLowerCase();
            let translatedContent: string;

            if (extension === ".md") {
              translatedContent = await provider.translateMarkdown(
                content,
                config
              );
            } else if (extension === ".csv") {
              translatedContent = await provider.translateCsv(content, config);
            } else {
              // その他のファイルタイプはそのまま
              translatedContent = content;
            }

            // 出力先パスを取得
            const targetFile = fileExplorer.getTargetPath(sourceFile, config);

            // 出力先ディレクトリが存在するか確認し、なければ作成
            fileExplorer.ensureTargetDirectoryExists(targetFile);

            // ファイル出力
            fs.writeFileSync(targetFile, translatedContent, "utf-8");

            successCount++;
          } catch (error) {
            console.error(`ファイル翻訳エラー: ${sourceFile}`, error);
            errorCount++;
          }
        }

        // 完了通知
        vscode.window.showInformationMessage(
          `翻訳完了: ${successCount}個成功, ${errorCount}個失敗`
        );
      } catch (error) {
        // エラーハンドリング
        vscode.window.showErrorMessage(
          `翻訳処理中にエラーが発生しました: ${(error as Error).message}`
        );
        console.error(error);
      }
    }
  );

  context.subscriptions.push(translateDisposable);
}

export function deactivate() {}
