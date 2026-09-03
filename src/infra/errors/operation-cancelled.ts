/**
 * @file operation-cancelled.ts
 * @description
 *   「ユーザーが止めた」ことを表す唯一の例外型と、その判定。
 *
 *   以前はキャンセルの表し方が層ごとに違い（`Error("Translation cancelled")` /
 *   `Error("Request aborted")` / `Error("Operation cancelled")` / プロバイダ名つきの
 *   ラップ）、判定側は文字列一致に頼っていたため、どれも「キャンセル」と認識されず
 *   正常な中断が赤いエラー通知になっていた。中断を投げる層はこの型だけを投げ、
 *   受け取る層は `isOperationCancelled` だけで判定する。
 *
 *   VS Code 非依存（infra の下位・プロバイダからも使える）。VS Code の
 *   `CancellationError` は `name` が `"Canceled"` なので、名前で拾って同じ扱いにする。
 * @module infra/errors/operation-cancelled
 */

/** VS Code の CancellationError が名乗る name（vscode を import せずに拾うため） */
const VSCODE_CANCELLATION_NAMES = new Set(["Canceled", "CancellationError"]);

/**
 * ユーザーによる中断を表す例外。
 *
 * **失敗ではない。** 受け取った側はエラー通知ではなく「中断しました」として扱い、
 * ステータスに `Status.Error` を刻まない。
 */
export class OperationCancelledError extends Error {
	constructor(message = "Operation cancelled") {
		super(message);
		this.name = "OperationCancelledError";
		// ES5 ターゲットでの instanceof 維持
		Object.setPrototypeOf(this, OperationCancelledError.prototype);
	}
}

/**
 * 例外がユーザーによる中断かを判定する。
 *
 * `OperationCancelledError` に加え、VS Code / 言語モデル API が投げる
 * `CancellationError`（name が `"Canceled"`）も中断として扱う。
 * **メッセージ本文での判定はしない** — プロバイダが文言を変えただけで
 * 黙って壊れるうえ、原稿にたまたま含まれる語を誤検知するため。
 */
export function isOperationCancelled(error: unknown): boolean {
	if (error instanceof OperationCancelledError) {
		return true;
	}
	return error instanceof Error && VSCODE_CANCELLATION_NAMES.has(error.name);
}

/**
 * 中断ならそのまま再スローし、そうでなければ false を返す。
 * プロバイダの catch 節で「中断だけはラップせず素通しする」ために使う。
 */
export function rethrowIfCancelled(error: unknown): void {
	if (isOperationCancelled(error)) {
		throw error instanceof OperationCancelledError ? error : new OperationCancelledError((error as Error).message);
	}
}
