import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { Configuration } from "../../config/configuration";
import { markdownParser } from "../../core/markdown/parser";
import { StatusManager } from "../../core/status/status-manager";
import { FileExplorer } from "../../utils/file-explorer";

/**
 * Markdownファイルから全てのmdaitマーカーを削除する
 * @param filePath ファイルパス
 * @returns 削除されたマーカー数
 */
async function removeMarkersFromFile(filePath: string): Promise<number> {
	const content = fs.readFileSync(filePath, "utf-8");
	const config = Configuration.getInstance();

	// パースしてユニットを取得
	const markdown = markdownParser.parse(content, config);

	// マーカーを削除したMarkdownを生成
	const resultLines: string[] = [];

	// FrontMatterを保持
	if (markdown.frontMatter && !markdown.frontMatter.isEmpty()) {
		resultLines.push(markdown.frontMatter.raw);
	}

	// 各ユニットからマーカーを除去してコンテンツのみを出力
	let markerCount = 0;
	for (const unit of markdown.units) {
		// マーカーが存在していた場合のみカウント
		if (unit.marker.hash || unit.marker.from || unit.marker.need) {
			markerCount++;
		}
		// コンテンツのみを追加（マーカーは含めない）
		// コンテンツの末尾の改行を除去してから追加（パーサーのstringifyと同様）
		resultLines.push(unit.content.replace(/\n+$/g, ""));
	}

	// ファイルに書き込み
	// FrontMatterがある場合とない場合で処理を分ける
	let result: string;
	if (markdown.frontMatter && !markdown.frontMatter.isEmpty()) {
		// FrontMatterは既に末尾に改行を含んでいるので、そのまま結合
		const frontMatter = resultLines.shift() || "";
		result = `${frontMatter}${resultLines.join("\n\n")}\n`;
	} else {
		// FrontMatterがない場合は、ユニット間を2つの改行で結合
		result = `${resultLines.join("\n\n")}\n`;
	}
	fs.writeFileSync(filePath, result, "utf-8");

	return markerCount;
}

/**
 * ディレクトリ内の全Markdownファイルをfinalize
 * @param directory ディレクトリパス
 */
export async function finalizeDirectoryCommand(directory: string): Promise<void> {
	try {
		const config = Configuration.getInstance();
		const validationError = config.validate();
		if (validationError) {
			vscode.window.showErrorMessage(vscode.l10n.t("Configuration error: {0}", validationError));
			return;
		}

		// ディレクトリ内の全Markdownファイルを取得
		const fileExplorer = new FileExplorer();
		const files = await fileExplorer.getAllMarkdownFiles(directory, config);

		if (files.length === 0) {
			vscode.window.showWarningMessage(vscode.l10n.t("No Markdown files found in directory: {0}", directory));
			return;
		}

		// 確認ダイアログ
		const confirmation = await vscode.window.showWarningMessage(
			vscode.l10n.t(
				"Remove all mdait markers from {0} file(s)? This operation cannot be undone.",
				files.length.toString(),
			),
			{ modal: true },
			vscode.l10n.t("Remove"),
		);

		if (confirmation !== vscode.l10n.t("Remove")) {
			return;
		}

		// 進捗表示で処理
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: vscode.l10n.t("Finalizing directory..."),
				cancellable: false,
			},
			async (progress: vscode.Progress<{ message?: string; increment?: number }>) => {
				let totalMarkers = 0;
				let processedFiles = 0;

				for (const file of files) {
					const markerCount = await removeMarkersFromFile(file);
					totalMarkers += markerCount;
					processedFiles++;

					progress.report({
						message: vscode.l10n.t("{0}/{1} files", processedFiles.toString(), files.length.toString()),
						increment: (100 / files.length),
					});

					// StatusManagerをリフレッシュ
					await StatusManager.getInstance().refreshFileStatus(file);
				}

				vscode.window.showInformationMessage(
					vscode.l10n.t(
						"Removed {0} markers from {1} file(s)",
						totalMarkers.toString(),
						processedFiles.toString(),
					),
				);
			},
		);
	} catch (error) {
		console.error("Error finalizing directory:", error);
		vscode.window.showErrorMessage(
			vscode.l10n.t("Failed to finalize directory: {0}", (error as Error).message),
		);
	}
}

/**
 * 単一ファイルをfinalize
 * @param filePath ファイルパス
 */
export async function finalizeFileCommand(filePath: string): Promise<void> {
	try {
		const config = Configuration.getInstance();
		const validationError = config.validate();
		if (validationError) {
			vscode.window.showErrorMessage(vscode.l10n.t("Configuration error: {0}", validationError));
			return;
		}

		// ファイルの存在確認
		if (!fs.existsSync(filePath)) {
			vscode.window.showErrorMessage(vscode.l10n.t("File not found: {0}", filePath));
			return;
		}

		// 確認ダイアログ
		const fileName = path.basename(filePath);
		const confirmation = await vscode.window.showWarningMessage(
			vscode.l10n.t("Remove all mdait markers from {0}? This operation cannot be undone.", fileName),
			{ modal: true },
			vscode.l10n.t("Remove"),
		);

		if (confirmation !== vscode.l10n.t("Remove")) {
			return;
		}

		// マーカー削除
		const markerCount = await removeMarkersFromFile(filePath);

		// StatusManagerをリフレッシュ
		await StatusManager.getInstance().refreshFileStatus(filePath);

		vscode.window.showInformationMessage(
			vscode.l10n.t("Removed {0} markers from {1}", markerCount.toString(), fileName),
		);
	} catch (error) {
		console.error("Error finalizing file:", error);
		vscode.window.showErrorMessage(vscode.l10n.t("Failed to finalize file: {0}", (error as Error).message));
	}
}
