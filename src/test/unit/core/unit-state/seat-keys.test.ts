// 席のキー（unit-state の seat 列）の決め方のテスト。
//
// 席のキーは「いまの本文の何番目か」ではなく「二度と動かない背番号」である。
// 毎回 0..N-1 に振り直していた頃は、章を1つ挿すだけでその記事のブロックが丸ごと
// 書き換わり、同じ記事への別の編集と必ず領域が重なっていた（実測 S2 / S9 / S10）。

import { strict as assert } from "node:assert";
import { assignSeats, isSeatKey, seatBetween } from "../../../../core/unit-state/seat-keys";

/** 狭義単調増加で、どれも席のキーとして読める形か */
function assertWellFormed(seats: readonly string[]): void {
	for (let i = 0; i < seats.length; i++) {
		assert.ok(isSeatKey(seats[i]), `席のキーとして読めない: ${seats[i]}`);
		if (i > 0) {
			assert.ok(seats[i - 1] < seats[i], `並びが増えていない: ${seats[i - 1]} → ${seats[i]}`);
		}
	}
}

suite("席のキー", () => {
	suite("形", () => {
		test("整数部が8桁で、小数部の末尾が 0 でなければ読める", () => {
			assert.ok(isSeatKey("50000000"));
			assert.ok(isSeatKey("50000000i"));
			assert.ok(isSeatKey("00000000zzz1"));
		});

		test("桁が足りない・小数部が 0 で終わる・使えない文字は読めない", () => {
			assert.ok(!isSeatKey("5000000"), "整数部が7桁");
			assert.ok(!isSeatKey("5000000a"), "整数部が数字でない");
			assert.ok(!isSeatKey("50000000i0"), "小数部が 0 で終わる");
			assert.ok(!isSeatKey("50000000A"), "小数部に使えない文字");
			assert.ok(!isSeatKey(""));
		});
	});

	suite("あいだのキーを作る", () => {
		test("どちらも無ければ真ん中から始める", () => {
			const key = seatBetween(null, null);
			assert.ok(isSeatKey(key));
			assert.ok(key > "00000000" && key < "99999999", "上へも下へも余地を残す");
		});

		test("整数のあいだが空いていれば整数だけで済む", () => {
			const key = seatBetween("50000000", "50001024");
			assert.strictEqual(key, "50000512");
		});

		test("整数が隣り合っていれば小数部を伸ばす", () => {
			const key = seatBetween("50000000", "50000001");
			assert.ok(key > "50000000" && key < "50000001", `あいだに入っていない: ${key}`);
			assert.ok(isSeatKey(key));
		});

		test("同じ隙間へ何度でも割り込める（刻みが尽きない）", () => {
			let lo = "50000000";
			const hi = "50000001";
			for (let i = 0; i < 200; i++) {
				const key = seatBetween(lo, hi);
				assert.ok(lo < key && key < hi, `${i} 回目で並びが壊れた: ${lo} < ${key} < ${hi}`);
				assert.ok(isSeatKey(key));
				lo = key;
			}
		});

		test("末尾へ足すときはキーが伸びない", () => {
			let last = seatBetween(null, null);
			for (let i = 0; i < 500; i++) {
				last = seatBetween(last, null);
				assert.strictEqual(last.length, 8, `${i} 回目でキーが伸びた: ${last}`);
			}
		});

		test("先頭へ足すときもキーが伸びない", () => {
			let first = seatBetween(null, null);
			for (let i = 0; i < 500; i++) {
				const key = seatBetween(null, first);
				assert.ok(key < first, `並びが壊れた: ${key} < ${first}`);
				assert.strictEqual(key.length, 8, `${i} 回目でキーが伸びた: ${key}`);
				first = key;
			}
		});

		test("並びが逆なら作らずに失敗する", () => {
			assert.throws(() => seatBetween("50001024", "50000000"), RangeError);
			assert.throws(() => seatBetween("50000000", "50000000"), RangeError);
		});
	});

	suite("ユニットごとに席を配る", () => {
		test("ユニットが0件なら席も0件", () => {
			assert.deepStrictEqual(assignSeats([]), []);
		});

		test("全部が新しいときは刻みをそろえて並べる", () => {
			const seats = assignSeats([undefined, undefined, undefined]);
			assertWellFormed(seats);
			assert.strictEqual(seats.length, 3);
		});

		test("既に座っている席は1つも動かさない", () => {
			const given = ["50000000", "50001024", "50002048"];
			assert.deepStrictEqual(assignSeats(given), given);
		});

		test("章を1つ挿し込んでも、前後の席は動かない（増えるのは1行だけ）", () => {
			const seats = assignSeats(["50000000", undefined, "50001024", "50002048"]);
			assert.deepStrictEqual([seats[0], seats[2], seats[3]], ["50000000", "50001024", "50002048"]);
			assertWellFormed(seats);
		});

		test("先頭・末尾に章が増えても、既にある席は動かない", () => {
			const seats = assignSeats([undefined, "50000000", "50001024", undefined]);
			assert.deepStrictEqual([seats[1], seats[2]], ["50000000", "50001024"]);
			assertWellFormed(seats);
		});

		test("同じ隙間に2つ挿し込んでも、前後の席は動かない", () => {
			const seats = assignSeats(["50000000", undefined, undefined, "50001024"]);
			assert.deepStrictEqual([seats[0], seats[3]], ["50000000", "50001024"]);
			assertWellFormed(seats);
		});

		test("章が移動して並びが逆転したら、その章の席だけを配り直す", () => {
			// 3番目の章が先頭へ移った
			const seats = assignSeats(["50002048", "50000000", "50001024"]);
			assertWellFormed(seats);
			assert.strictEqual(seats[0], "50002048", "先頭に来た章は席を持ったまま");
		});

		test("席のキーとして読めない値は身元に使わない", () => {
			const seats = assignSeats(["", "50000000", "ずれた値"]);
			assertWellFormed(seats);
			assert.strictEqual(seats[1], "50000000");
		});
	});
});
