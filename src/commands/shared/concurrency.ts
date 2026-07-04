/**
 * @file concurrency.ts
 * @description
 *   セマフォ方式の並列実行ヘルパー。ディレクトリ翻訳などファイル単位の独立タスクを
 *   同時実行数上限つきで並列処理する（architecture.md「意図的制約」の並列化解除）。
 *   同一ファイルへの書き込み競合は FileMutex が排他するため、ここでは関知しない。
 *   VS Code API 非依存・単体テスト可能。
 * @module commands/shared/concurrency
 */

/** trans.concurrency の許容範囲 */
export const MIN_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 8;

/** 同時実行数を許容範囲にクランプする */
export function clampConcurrency(value: number | undefined, defaultValue = 3): number {
	if (value === undefined || Number.isNaN(value)) {
		return defaultValue;
	}
	return Math.max(MIN_CONCURRENCY, Math.min(MAX_CONCURRENCY, Math.floor(value)));
}

/**
 * items を同時実行数 limit で並列処理する。
 * - 結果は items と同じ順序で返す
 * - shouldStop が true を返した時点で新規タスクの着手を止める（実行中タスクは完走）
 * - worker が例外を投げると全体が reject し呼び出し側へ伝播する。個々の失敗で
 *   全体を落としたくない場合は、worker 側で例外を捕捉し結果型で成否を表現すること
 *
 * @param items 処理対象
 * @param limit 同時実行数（1で逐次実行）
 * @param worker 各アイテムの処理
 * @param shouldStop 新規着手を止める判定（キャンセルトークン等）
 * @returns 完了したアイテムの結果（未着手アイテムの位置は undefined）
 */
export async function runWithConcurrency<TItem, TResult>(
	items: readonly TItem[],
	limit: number,
	worker: (item: TItem, index: number) => Promise<TResult>,
	shouldStop?: () => boolean,
): Promise<Array<TResult | undefined>> {
	const results: Array<TResult | undefined> = new Array(items.length);
	const effectiveLimit = Math.max(MIN_CONCURRENCY, Math.min(limit, items.length));
	let nextIndex = 0;

	const runner = async (): Promise<void> => {
		while (true) {
			if (shouldStop?.()) {
				return;
			}
			const index = nextIndex++;
			if (index >= items.length) {
				return;
			}
			results[index] = await worker(items[index], index);
		}
	};

	await Promise.all(Array.from({ length: effectiveLimit }, () => runner()));
	return results;
}
