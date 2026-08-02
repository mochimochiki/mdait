/**
 * @file cancellation.ts
 * @description ユーザーによるキャンセルと本物のエラーを区別する共有ヘルパー。
 *
 * 判定の実体は `infra/errors/operation-cancelled` にある（VS Code 非依存にして
 * プロバイダ層からも同じ型を投げられるようにするため）。ここは commands 層からの
 * 入口として残す。
 */
export { OperationCancelledError, isOperationCancelled } from "../../infra/errors/operation-cancelled";
import { isOperationCancelled } from "../../infra/errors/operation-cancelled";

/**
 * エラーがユーザーキャンセル由来かを判定する。
 * @deprecated `isOperationCancelled` を直接使うこと。既存呼び出しのための別名。
 */
export function isCancellationError(error: unknown): boolean {
	return isOperationCancelled(error);
}
