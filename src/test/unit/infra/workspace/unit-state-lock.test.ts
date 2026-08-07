// unit-state ストア全体の排他の検証。
//
// 守っているのは1ファイルの読み書きではなく「ストアをメモリへ読み込んでから書き戻すまで」
// である。syncCommand はその区間の入口で load() を無条件に呼ぶため、区間に割り込んだ
// 書き換え（リネームへの追随）は読み捨てられるか上書きで消える。しかも無言で消える。
// 直列化が崩れた瞬間にその壊れ方が戻るので、順序と解放をここで固定する。

import * as assert from "node:assert";
import {
	acquireUnitStateLock,
	resetUnitStateLock,
	withUnitStateLock,
} from "../../../../infra/workspace/unit-state-lock";

/** 次のマイクロタスクまで待つ（区間が本当に重ならないことを確かめるための間） */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

suite("unit-state ストアの排他", () => {
	setup(() => {
		resetUnitStateLock();
	});

	teardown(() => {
		resetUnitStateLock();
	});

	test("区間が重ならないこと", async () => {
		const log: string[] = [];
		const section = async (name: string): Promise<void> => {
			await withUnitStateLock(async () => {
				log.push(`${name}:in`);
				await tick();
				log.push(`${name}:out`);
			});
		};

		await Promise.all([section("A"), section("B")]);

		assert.deepStrictEqual(log, ["A:in", "A:out", "B:in", "B:out"]);
	});

	test("獲得を頼んだ順に実行されること（FIFO）", async () => {
		const order: number[] = [];
		const tasks = [0, 1, 2, 3].map((i) =>
			withUnitStateLock(async () => {
				await tick();
				order.push(i);
			}),
		);
		await Promise.all(tasks);

		assert.deepStrictEqual(order, [0, 1, 2, 3]);
	});

	test("区間が例外で終わっても次の区間が動くこと", async () => {
		await assert.rejects(
			withUnitStateLock(async () => {
				throw new Error("boom");
			}),
			/boom/,
		);

		let ran = false;
		await withUnitStateLock(async () => {
			ran = true;
		});
		assert.strictEqual(ran, true, "解放されずに固まっていないこと");
	});

	test("解放するまで後続が待つこと（acquire を使う長い区間）", async () => {
		const held = await acquireUnitStateLock();
		let entered = false;
		const waiting = withUnitStateLock(async () => {
			entered = true;
		});

		await tick();
		assert.strictEqual(entered, false, "解放前に入らないこと");

		held.release();
		await waiting;
		assert.strictEqual(entered, true);
	});

	test("二重に解放しても後続を巻き込まないこと", async () => {
		const held = await acquireUnitStateLock();
		held.release();
		held.release();

		const log: string[] = [];
		await Promise.all([
			withUnitStateLock(async () => {
				log.push("first:in");
				await tick();
				log.push("first:out");
			}),
			withUnitStateLock(async () => {
				log.push("second:in");
			}),
		]);

		assert.deepStrictEqual(log, ["first:in", "first:out", "second:in"]);
	});
});
