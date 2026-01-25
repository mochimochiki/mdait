import * as vscode from "vscode";
import { FrontMatter } from "../../core/markdown/front-matter";
import { syncLevelSettings } from "../../core/markdown/level-sync";

/**
 * 原文と訳文のfrontmatterでmdait.sync.levelの設定値を検証し、不一致の場合は訳文を原文に合わせて修正する
 *
 * @param sourceFile 原文ファイルパス
 * @param targetFile 訳文ファイルパス
 * @returns level設定が修正されたかどうか
 * @throws ファイル読み込み、パース、または書き込みに失敗した場合
 */
export async function validateAndSyncLevel(sourceFile: string, targetFile: string): Promise<boolean> {
	try {
		const decoder = new TextDecoder("utf-8");
		const encoder = new TextEncoder();

		// ファイル読み込み
		const sourceDoc = await vscode.workspace.fs.readFile(vscode.Uri.file(sourceFile));
		const targetDoc = await vscode.workspace.fs.readFile(vscode.Uri.file(targetFile));
		const sourceContent = decoder.decode(sourceDoc);
		const targetContent = decoder.decode(targetDoc);

		// 原文のfrontmatterのみを解析
		const { frontMatter: sourceFrontMatter } = FrontMatter.parse(sourceContent);

		// level設定を同期
		const result = syncLevelSettings(sourceFrontMatter, targetContent);

		// 修正が必要な場合はファイルを保存
		if (result.modified && result.updatedTargetContent) {
			await vscode.workspace.fs.writeFile(vscode.Uri.file(targetFile), encoder.encode(result.updatedTargetContent));
			const sourceLevel = sourceFrontMatter?.get<number>("mdait.sync.level");
			console.log(`mdait: Synced level setting in ${targetFile} to match source (${sourceLevel ?? "undefined"})`);
		}

		return result.modified;
	} catch (error) {
		console.error(`mdait: Failed to validate and sync level settings between ${sourceFile} and ${targetFile}:`, error);
		throw error;
	}
}
