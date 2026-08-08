/**
 * @file unit-state-lock.ts
 * @description
 *   `unit-state` ストア**全体**の排他。
 *
 *   `FileMutex` はファイルパス単位なので、この用途には使えない。守りたいのは1ファイルの
 *   読み書きではなく「ストアをメモリへ読み込んでから書き戻すまでの区間」だからである。
 *
 *   なぜ要るか: `syncCommand` は開始時に `load()` を**無条件に**呼び、終了時に `save()` する。
 *   その間に他の処理がメモリ上の行を書き換えても、`load()` の側が先なら書き換えは
 *   読み捨てられ、`save()` の側が後なら書き換えは上書きで消える。どちらも無言で起きる。
 *   リネームへの追随（`relocateUnitEntries`）はまさにこの区間に割り込むため、
 *   sync が走っているあいだは待たせる必要がある（docs/design/unit-state.md §8）。
 *
 *   待たせても操作は失われない。ファイルの移動そのものは VS Code が済ませており、
 *   ここで待つのは行の付け替えだけである。
 *
 *   再入は非対応 — この区間の中からこの区間をもう一度獲りにいくと待機し続ける。
 *   呼び出し側は「ストアを読み込んでから書き戻すまで」を1回で囲むこと。
 *
 * @module infra/workspace/unit-state-lock
 */

/** 獲得したロックの解放権 */
export interface UnitStateLockHandle {
	/** 解放する。多重呼び出しは無害 */
	release(): void;
}

/** 待ち行列の末尾。獲得順（FIFO）に実行される */
let tail: Promise<void> = Promise.resolve();

/**
 * ストアの読み書き区間のロックを獲得する。**必ず `finally` で解放すること。**
 *
 * 区間が長く、途中に `continue` や早期 return を含む処理（sync）向けの入口。
 * コールバックで囲む形にすると本体を丸ごと字下げし直すことになり、
 * ロックを足したことと処理を動かしたことが差分の上で見分けられなくなる。
 */
export async function acquireUnitStateLock(): Promise<UnitStateLockHandle> {
	const prior = tail;
	let open!: () => void;
	const gate = new Promise<void>((resolve) => {
		open = resolve;
	});
	tail = prior.then(() => gate);
	await prior;
	let released = false;
	return {
		release(): void {
			if (released) {
				return; // 二重解放で後続の待ち行列を巻き込まない
			}
			released = true;
			open();
		},
	};
}

/**
 * ストアの読み書き区間を排他して実行する。
 *
 * @param task 区間の中身。例外を投げてもロックは解放される
 */
export async function withUnitStateLock<T>(task: () => Promise<T>): Promise<T> {
	const held = await acquireUnitStateLock();
	try {
		return await task();
	} finally {
		held.release();
	}
}

/** 待ち行列を空にする（主にテスト用） */
export function resetUnitStateLock(): void {
	tail = Promise.resolve();
}
