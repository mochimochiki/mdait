/**
 * @file seat-numbers.ts
 *   `unit-state` の行に振る「席番号」（`order`）を決める。
 *
 *   席番号は**いまの本文の何番目か**ではなく、**二度と動かない背番号**である。章を1つ
 *   挿入したときに書き換わるのがその1行だけになるように、既に座っている行の番号は
 *   据え置き、新しい章には前後の中点を配る。
 *
 *   なぜ据え置きが要るか。`.mdait/unit-state` は全員が1つのファイルへ書き込むので、
 *   章を1つ挿入するたびにその記事のブロックが丸ごと書き換わっていると、同じ記事への
 *   別の編集とは**必ず**領域が重なる。3方向マージはそこで手が出せなくなり、
 *   バージョン管理の専門家ではない翻訳者に競合マーカーの解決を求めることになる
 *   （実測: `node scripts/lab/lab.mjs merge` の S2 / S9 / S10）。
 *
 *   読み取り側は既に番号を身元に使っていない（`unit-state-align.ts` は本文と見出しの
 *   hash で突き合わせる）。番号に残っている仕事は「本文の並びを表す」ことだけなので、
 *   **並びさえ保たれていれば値そのものは何でもよい**。
 *
 * @module core/unit-state/seat-numbers
 */

/**
 * 新しく席を作るときの刻み。
 *
 * 1つの隙間に何回続けて章を挿し込めるかを決める（256 なら 8 回。9 回目で番号を振り直す）。
 * 大きくすると挿し込みに強くなり、1ファイルに置ける章の数が減る。
 */
export const SEAT_STRIDE = 256;

/**
 * ユニットごとの席番号を決める。
 *
 * @param preferred ユニットごとの「いま座っている席」。対応する行が無ければ `undefined`
 * @param limit 席番号の上限（この値**未満**に収める。保留席の始まり）
 * @returns ユニットと同じ長さの、狭義単調増加な席番号の配列
 */
export function assignSeats(preferred: readonly (number | undefined)[], limit: number): number[] {
	const count = preferred.length;
	if (count === 0) {
		return [];
	}

	// 1. 据え置ける席だけを残す。並びが逆転しているもの（＝章が移動した）は手放す。
	//    ここで単調な最大部分列を取り直すこともできるが、移動した章はどのみち
	//    ブロックが書き換わるので、素直に前から見て通らないものを落とす
	const kept: Array<number | undefined> = new Array(count).fill(undefined);
	let last = -1;
	for (let i = 0; i < count; i++) {
		const seat = preferred[i];
		if (seat === undefined || !Number.isInteger(seat) || seat < 0 || seat >= limit || seat <= last) {
			continue;
		}
		kept[i] = seat;
		last = seat;
	}

	// 2. 空いているところへ、前後のあいだの値を配る
	const seats: number[] = new Array(count).fill(-1);
	for (let i = 0; i < count; i++) {
		if (kept[i] !== undefined) {
			seats[i] = kept[i] as number;
		}
	}
	let i = 0;
	while (i < count) {
		if (kept[i] !== undefined) {
			i++;
			continue;
		}
		let end = i;
		while (end < count && kept[end] === undefined) {
			end++;
		}
		const lo = i === 0 ? 0 : (kept[i - 1] as number);
		const hi = end === count ? limit : (kept[end] as number);
		const need = end - i;
		// 入り切らないなら、そのファイルの番号を振り直す。**滅多に起きないが、
		// 起きたときに黙って番号が重なるよりは、1回だけブロックを書き換えるほうがよい**
		if (hi - lo - 1 < need) {
			return renumberAll(count, limit);
		}
		const room = Math.floor((hi - lo) / (need + 1));
		const step = Math.max(1, end === count ? Math.min(SEAT_STRIDE, room) : room);
		for (let j = 0; j < need; j++) {
			seats[i + j] = lo + step * (j + 1);
		}
		i = end;
	}
	return seats;
}

/**
 * そのファイルの席番号を一から振り直す。
 *
 * 前後のあいだに値が作れなくなったときの逃げ道である。ブロックが丸ごと書き換わるので
 * 合流ではぶつかりうるが、**その回はどのみち行が増減している**ので、新しく壊れるものは無い。
 * 振り直したあとは刻みが戻るので、次からはまた1行の変更で済む。
 */
function renumberAll(count: number, limit: number): number[] {
	const step = Math.max(1, Math.min(SEAT_STRIDE, Math.floor(limit / (count + 1))));
	return Array.from({ length: count }, (_, i) => step * (i + 1));
}
