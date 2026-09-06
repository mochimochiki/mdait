/**
 * @file seat-keys.ts
 *   `unit-state` の行に振る「席のキー」を決める。
 *
 *   席のキーは**いまの本文の何番目か**ではなく、**二度と動かない背番号**である。章を1つ
 *   挿入したときに書き換わるのがその1行だけになるように、既に座っている行のキーは据え置き、
 *   新しい章には前後のあいだのキーを配る。
 *
 *   なぜ据え置きが要るか。`.mdait/unit-state` は全員が1つのファイルへ書き込むので、章を1つ
 *   挿入するたびにその記事のブロックが丸ごと書き換わっていると、同じ記事への別の編集とは
 *   **必ず**領域が重なる。3方向マージはそこで手が出せなくなり、バージョン管理の専門家では
 *   ない翻訳者に競合マーカーの解決を求めることになる（実測: `node scripts/lab/lab.mjs merge`）。
 *
 *   読み取り側はキーを身元に使っていない（`unit-state-align.ts` は本文と見出しの hash で
 *   突き合わせる）。キーに残っている仕事は「本文の並びを表す」ことだけなので、**並びさえ
 *   保たれていれば値そのものは何でもよい**。
 *
 * ## キーの形
 *
 * ```
 * 00051200      整数だけ（ふつうの席）
 * 00051200i     整数 + 小数部（隣り合う整数のあいだに割り込んだ席）
 * 00051200ri    さらにそのあいだ
 * ```
 *
 * - 整数部は**桁数を固定した10進数**（8桁）。桁を固定すると、文字列を前から比べた順序と
 *   数の順序が一致する。可変長にすると `100000000` が `50000000` より小さいと判定される。
 * - 小数部は `0`〜`9`・`a`〜`z` の36進で、**末尾に `0` を置かない**。この決まりがあると
 *   「どの2つのキーのあいだにも必ず新しいキーが作れる」ことが保証される（`0` で終わって
 *   よいと、`…0` と `…` のあいだが空になる）。
 *
 * この形なら**刻みが尽きることが無い**。整数のあいだが埋まったら小数部が1桁伸びるだけで、
 * 番号の振り直し（＝その記事のブロックを丸ごと書き換える操作）が要らない。
 *
 * @module core/unit-state/seat-keys
 */

/** 整数部の桁数。固定でなければ文字列の順序と数の順序が一致しない */
const INT_DIGITS = 8;

/** 整数部の上限（この値未満） */
const INT_LIMIT = 10 ** INT_DIGITS;

/**
 * 新しいファイルの席を並べ始める位置と刻み。
 *
 * 真ん中あたりから始めるのは、**先頭に章を足す**余地を残すためである。1024 刻みなら
 * 下へ 48000 回以上、上へ 48000 回以上ふつうに足せる。
 */
const BASE = 50_000_000;
const STRIDE = 1024;

/** 小数部に使える文字。並びは文字コードの昇順と一致する */
const DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz";

/** 席のキーとして読める形か */
export function isSeatKey(key: string): boolean {
	if (key.length < INT_DIGITS) {
		return false;
	}
	const int = key.slice(0, INT_DIGITS);
	if (!/^[0-9]{8}$/.test(int)) {
		return false;
	}
	const frac = key.slice(INT_DIGITS);
	if (frac === "") {
		return true;
	}
	return /^[0-9a-z]+$/.test(frac) && !frac.endsWith("0");
}

/** 整数部（数）と小数部（文字列）に割る */
function split(key: string): { int: number; frac: string } {
	return { int: Number.parseInt(key.slice(0, INT_DIGITS), 10), frac: key.slice(INT_DIGITS) };
}

/** 整数部と小数部からキーを組み立てる */
function join(int: number, frac: string): string {
	return `${String(int).padStart(INT_DIGITS, "0")}${frac}`;
}

/**
 * 2つの小数部のあいだの小数部を作る。
 *
 * `b` が `null` なら「その整数の中で `a` より後ろ」という意味になる（次の整数までの
 * あいだに置く）。**必ず `a` より後ろで `b` より前**、かつ末尾が `0` にならない。
 */
function fractionBetween(a: string, b: string | null): string {
	if (b !== null) {
		// 共通の頭を切り落としてから考える。`a` が短いぶんは `0` が続いているとみなす
		let n = 0;
		while ((a[n] ?? DIGITS[0]) === b[n]) {
			n++;
		}
		if (n > 0) {
			return b.slice(0, n) + fractionBetween(a.slice(n), b.slice(n));
		}
	}
	const from = a === "" ? 0 : DIGITS.indexOf(a[0]);
	const to = b === null ? DIGITS.length : DIGITS.indexOf(b[0]);
	if (to - from > 1) {
		return DIGITS[Math.round(0.5 * (from + to))];
	}
	// 先頭の桁が隣り合っている。`b` に続きがあるならそこを頭に取り、
	// 無ければ `a` の頭を据えて次の桁へ降りる
	if (b !== null && b.length > 1) {
		return b.slice(0, 1);
	}
	return DIGITS[from] + fractionBetween(a.slice(1), null);
}

/**
 * `a` と `b` のあいだの席のキーを作る。
 *
 * @param a 直前の席（無ければ `null`）
 * @param b 直後の席（無ければ `null`）
 * @throws `a` が `b` 以上のとき、または席を割り込ませる先が尽きたとき
 */
export function seatBetween(a: string | null, b: string | null): string {
	if (a !== null && b !== null && a >= b) {
		throw new RangeError(`Seat keys are out of order: ${a} >= ${b}`);
	}
	if (a === null && b === null) {
		return join(BASE, "");
	}
	if (a === null) {
		const next = split(b as string);
		if (next.int >= STRIDE) {
			return join(next.int - STRIDE, "");
		}
		if (next.int >= 1) {
			return join(Math.floor(next.int / 2), "");
		}
		// **ここへは実質たどり着かない。** 先頭へ章を足す操作を 48000 回以上繰り返して
		// 初めて起きる。黙って同じキーを二度使うより、そのファイルだけ失敗させる
		throw new RangeError("No room left below the first seat");
	}
	const prev = split(a);
	if (b === null) {
		if (prev.int + STRIDE < INT_LIMIT) {
			return join(prev.int + STRIDE, "");
		}
		if (prev.int + 1 < INT_LIMIT) {
			return join(prev.int + 1, "");
		}
		// 整数部が振り切れた。小数部を伸ばして同じ整数の中へ置く
		return join(prev.int, fractionBetween(prev.frac, null));
	}
	const next = split(b);
	if (next.int - prev.int > 1) {
		return join(Math.floor((prev.int + next.int) / 2), "");
	}
	// 整数のあいだが埋まっている。小数部を伸ばす（こちらは尽きない）
	return join(prev.int, fractionBetween(prev.frac, next.int === prev.int ? next.frac : null));
}

/**
 * ユニットごとの席のキーを決める。
 *
 * @param preferred ユニットごとの「いま座っている席」。対応する行が無ければ `undefined`
 * @returns ユニットと同じ長さの、狭義単調増加なキーの配列
 */
export function assignSeats(preferred: readonly (string | undefined)[]): string[] {
	const count = preferred.length;
	if (count === 0) {
		return [];
	}

	// 1. 据え置ける席だけを残す。並びが逆転しているもの（＝章が移動した）は手放す。
	//    単調な最大部分列を取り直すこともできるが、移動した章はどのみちブロックが
	//    書き換わるので、素直に前から見て通らないものを落とす
	const kept: Array<string | undefined> = new Array(count).fill(undefined);
	let last: string | undefined;
	for (let i = 0; i < count; i++) {
		const seat = preferred[i];
		if (seat === undefined || !isSeatKey(seat) || (last !== undefined && seat <= last)) {
			continue;
		}
		kept[i] = seat;
		last = seat;
	}

	// 2. 空いているところへ、前後のあいだのキーを配る
	const seats: string[] = new Array(count).fill("");
	for (let i = 0; i < count; i++) {
		const seat = kept[i];
		if (seat !== undefined) {
			seats[i] = seat;
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
		const lo = i === 0 ? null : (kept[i - 1] as string);
		const hi = end === count ? null : (kept[end] as string);
		// 区間の中へ順に置いていく。1つ置くたびに左端が進むので、何個でも入る
		let left = lo;
		for (let j = i; j < end; j++) {
			const created = seatBetween(left, hi);
			seats[j] = created;
			left = created;
		}
		i = end;
	}
	return seats;
}
