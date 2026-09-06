// 席番号（unit-state の order）の決め方のテスト。
//
// 席番号は「いまの本文の何番目か」ではなく「二度と動かない背番号」である。
// 毎回 0..N-1 に振り直していた頃は、章を1つ挿すだけでその記事のブロックが丸ごと
// 書き換わり、同じ記事への別の編集と必ず領域が重なっていた（実測 S2 / S9 / S10）。

import { strict as assert } from "node:assert";
import { SEAT_STRIDE, assignSeats } from "../../../../core/unit-state/seat-numbers";

const LIMIT = 1_000_000;

/** 狭義単調増加で、上限の内側に収まっているか */
function assertWellFormed(seats: readonly number[]): void {
	for (let i = 0; i < seats.length; i++) {
		assert.ok(Number.isInteger(seats[i]), `席が整数でない: ${seats[i]}`);
		assert.ok(seats[i] >= 0 && seats[i] < LIMIT, `席が範囲の外: ${seats[i]}`);
		if (i > 0) {
			assert.ok(seats[i - 1] < seats[i], `席の並びが増えていない: ${seats[i - 1]} → ${seats[i]}`);
		}
	}
}

suite("席番号の決め方", () => {
	test("ユニットが0件なら席も0件", () => {
		assert.deepStrictEqual(assignSeats([], LIMIT), []);
	});

	test("全部が新しいときは刻みで並べる", () => {
		const seats = assignSeats([undefined, undefined, undefined], LIMIT);
		assert.deepStrictEqual(seats, [SEAT_STRIDE, SEAT_STRIDE * 2, SEAT_STRIDE * 3]);
		assertWellFormed(seats);
	});

	test("既に座っている席は1つも動かさない", () => {
		const seats = assignSeats([256, 512, 768], LIMIT);
		assert.deepStrictEqual(seats, [256, 512, 768]);
	});

	test("章を1つ挿し込んでも、前後の席は動かない（増えるのは1行だけ）", () => {
		const seats = assignSeats([256, undefined, 512, 768], LIMIT);
		assert.deepStrictEqual(seats, [256, 384, 512, 768]);
		assertWellFormed(seats);
	});

	test("先頭に章が増えたときは、最初の席より小さい値を配る", () => {
		const seats = assignSeats([undefined, 256, 512], LIMIT);
		assert.deepStrictEqual(seats, [128, 256, 512]);
		assertWellFormed(seats);
	});

	test("末尾に章が増えたときは、刻みの分だけ先へ置く", () => {
		const seats = assignSeats([256, 512, undefined, undefined], LIMIT);
		assert.deepStrictEqual(seats, [256, 512, 512 + SEAT_STRIDE, 512 + SEAT_STRIDE * 2]);
		assertWellFormed(seats);
	});

	test("同じ隙間に2つ挿し込んでも、前後の席は動かない", () => {
		const seats = assignSeats([256, undefined, undefined, 512], LIMIT);
		assert.deepStrictEqual(seats, [256, 341, 426, 512]);
		assertWellFormed(seats);
	});

	test("章が移動して並びが逆転したら、その章の席だけを配り直す", () => {
		// 3番目の章が先頭へ移った（席 768 が先頭に来た）
		const seats = assignSeats([768, 256, 512], LIMIT);
		assertWellFormed(seats);
		assert.strictEqual(seats[0], 768, "先頭に来た章は席を持ったまま");
		assert.ok(seats[1] > 768 && seats[2] > seats[1], "残りは後ろへ配り直される");
	});

	test("隙間が尽きたら、そのファイルの番号を振り直す", () => {
		// 0 と 1 のあいだには値が作れない
		const seats = assignSeats([0, undefined, 1], LIMIT);
		assert.deepStrictEqual(seats, [SEAT_STRIDE, SEAT_STRIDE * 2, SEAT_STRIDE * 3]);
		assertWellFormed(seats);
	});

	test("0..N-1 で並んでいる古いファイルは、そのままなら動かさない", () => {
		const seats = assignSeats([0, 1, 2, 3], LIMIT);
		assert.deepStrictEqual(seats, [0, 1, 2, 3], "何も変わっていない回に書き直さない");
	});

	test("上限に収まらない席・負の席・保留席の番号は身元に使わない", () => {
		const seats = assignSeats([LIMIT, -1, 1.5], LIMIT);
		assert.deepStrictEqual(seats, [SEAT_STRIDE, SEAT_STRIDE * 2, SEAT_STRIDE * 3]);
		assertWellFormed(seats);
	});

	test("ユニットが多くても、席は上限の内側に収まる", () => {
		const seats = assignSeats(new Array(5000).fill(undefined), LIMIT);
		assert.strictEqual(seats.length, 5000);
		assertWellFormed(seats);
	});

	test("席の数より多いユニットは、黙って番号を重ねずに失敗する", () => {
		// 越えた行は保留席の番号に化け、順序では拾われない行として扱われてしまう。
		// 壊れた unit-state を書くより、そのファイルだけ失敗させる
		assert.throws(() => assignSeats(new Array(8).fill(undefined), 8), RangeError);
		// ぎりぎり収まる側は通る
		const seats = assignSeats(new Array(7).fill(undefined), 8);
		assert.strictEqual(seats.length, 7);
		for (const seat of seats) {
			assert.ok(seat >= 0 && seat < 8, `席が範囲の外: ${seat}`);
		}
	});
});
