import * as path from "node:path";
import * as vscode from "vscode";
import { Logger, formatError } from "../logging/logger";

const logger = Logger.getInstance();

/**
 * 指定ファイルがエディタで未保存の変更を持つ場合、ディスクに保存する。
 *
 * sync・trans はディスク上の内容を read-modify-write するため、未保存の
 * エディタバッファが残っていると (1) 古いディスク内容を処理してしまう、
 * (2) 後からユーザーが保存した瞬間にバッファが処理結果を上書きして
 * 翻訳結果やマーカーが消失する。処理前にバッファをディスクへ反映させる
 * ことで両者を一致させる。
 *
 * @param filePath 対象ファイルの絶対パス
 * @returns 保存に失敗した場合のみ false（未オープン・クリーンな場合は true）
 */
export async function flushDirtyDocument(filePath: string): Promise<boolean> {
	const resolved = path.resolve(filePath);
	const document = vscode.workspace.textDocuments.find(
		(doc) => doc.uri.scheme === "file" && path.resolve(doc.uri.fsPath) === resolved,
	);
	if (!document || !document.isDirty) {
		return true;
	}
	try {
		const saved = await document.save();
		if (!saved) {
			logger.warn("workspace", "Failed to save dirty document before write", {
				filePath,
			});
		}
		return saved;
	} catch (error) {
		logger.warn("workspace", "Error saving dirty document before write", {
			filePath,
			...formatError(error),
		});
		return false;
	}
}
