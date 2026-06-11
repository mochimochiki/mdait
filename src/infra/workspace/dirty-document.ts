import * as path from "node:path";
import * as vscode from "vscode";
import { Logger, formatError } from "../logging/logger";
import { normalizeFileKey } from "./file-key";

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
 * 保存に失敗した場合は例外を投げる。不整合のまま処理を続けると結局
 * 上書き消失を防げないため、呼び出し側の操作ごと中断させる。
 *
 * @param filePath 対象ファイルの絶対パス
 * @throws 未保存の変更をディスクへ保存できなかった場合
 */
export async function flushDirtyDocument(filePath: string): Promise<void> {
	const key = normalizeFileKey(filePath);
	const document = vscode.workspace.textDocuments.find(
		(doc) => doc.uri.scheme === "file" && normalizeFileKey(doc.uri.fsPath) === key,
	);
	if (!document || !document.isDirty) {
		return;
	}
	let saved = false;
	try {
		saved = await document.save();
	} catch (error) {
		logger.warn("workspace", "Error saving dirty document before write", {
			filePath,
			...formatError(error),
		});
	}
	if (!saved) {
		logger.warn("workspace", "Failed to save dirty document before write", {
			filePath,
		});
		throw new Error(
			vscode.l10n.t(
				"Could not save unsaved changes in {0}. The operation was aborted to avoid overwriting your edits.",
				path.basename(filePath),
			),
		);
	}
}
