/**
 * @file cancellation.ts
 * @description ユーザーによるキャンセルと本物のエラーを区別する共有ヘルパー。
 * withProgress のキャンセルは AI 呼び出しから vscode.CancellationError（または
 * name/message が "Canceled" のエラー）として表面化する。これをエラー通知に
 * 流すと、正常なキャンセルが「〜failed: Canceled」というエラートーストになる。
 */
import * as vscode from "vscode";

/**
 * エラーがユーザーキャンセル由来かを判定する。
 * VS Code の CancellationError と、LM API などが投げる name/message "Canceled" の
 * 素のエラーの両方を扱う。
 */
export function isCancellationError(error: unknown): boolean {
	if (typeof vscode.CancellationError === "function" && error instanceof vscode.CancellationError) {
		return true;
	}
	return error instanceof Error && (error.name === "Canceled" || error.message === "Canceled");
}
