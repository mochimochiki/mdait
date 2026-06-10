import * as assert from "node:assert";
import { FileMutex } from "../../../../infra/workspace/file-mutex";

/** 次のマイクロタスク/タイマーまで待つ */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

suite("FileMutex", () => {
	setup(() => {
		FileMutex.dispose();
	});

	teardown(() => {
		FileMutex.dispose();
	});

	test("同一キーのタスクは直列実行される", async () => {
		const mutex = FileMutex.getInstance();
		const order: string[] = [];
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		const first = mutex.runExclusive(["/ws/a.md"], async () => {
			order.push("first-start");
			await firstGate;
			order.push("first-end");
		});
		const second = mutex.runExclusive(["/ws/a.md"], async () => {
			order.push("second-start");
		});

		await tick();
		// firstが保持中の間、secondは開始されない
		assert.deepStrictEqual(order, ["first-start"]);

		releaseFirst();
		await Promise.all([first, second]);
		assert.deepStrictEqual(order, ["first-start", "first-end", "second-start"]);
	});

	test("異なるキーのタスクは並行実行される", async () => {
		const mutex = FileMutex.getInstance();
		const order: string[] = [];
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		const first = mutex.runExclusive(["/ws/a.md"], async () => {
			order.push("a-start");
			await firstGate;
		});
		const second = mutex.runExclusive(["/ws/b.md"], async () => {
			order.push("b-start");
		});

		await tick();
		// 別キーなのでaの完了を待たずbが実行される
		assert.deepStrictEqual(order, ["a-start", "b-start"]);

		releaseFirst();
		await Promise.all([first, second]);
	});

	test("複数キーは関係する全ての先行タスクを待つ", async () => {
		const mutex = FileMutex.getInstance();
		const order: string[] = [];
		let releaseA!: () => void;
		const gateA = new Promise<void>((resolve) => {
			releaseA = resolve;
		});

		const taskA = mutex.runExclusive(["/ws/a.md"], async () => {
			order.push("a-start");
			await gateA;
		});
		// [a, b] の複合ロックは a の解放を待つ
		const taskAB = mutex.runExclusive(["/ws/a.md", "/ws/b.md"], async () => {
			order.push("ab-start");
		});
		// b 単独はさらに ab の後ろに並ぶ
		const taskB = mutex.runExclusive(["/ws/b.md"], async () => {
			order.push("b-start");
		});

		await tick();
		assert.deepStrictEqual(order, ["a-start"]);

		releaseA();
		await Promise.all([taskA, taskAB, taskB]);
		assert.deepStrictEqual(order, ["a-start", "ab-start", "b-start"]);
	});

	test("タスクが例外を投げてもロックは解放される", async () => {
		const mutex = FileMutex.getInstance();

		await assert.rejects(
			mutex.runExclusive(["/ws/a.md"], async () => {
				throw new Error("boom");
			}),
			/boom/,
		);

		// 例外後も同じキーで実行できる
		const result = await mutex.runExclusive(["/ws/a.md"], async () => "ok");
		assert.strictEqual(result, "ok");
	});

	test("タスクの戻り値が返る", async () => {
		const mutex = FileMutex.getInstance();
		const result = await mutex.runExclusive(["/ws/a.md"], async () => 42);
		assert.strictEqual(result, 42);
	});

	test("パス表記の揺れ（相対・冗長セグメント）も同一キーとして扱う", async () => {
		const mutex = FileMutex.getInstance();
		const order: string[] = [];
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		const first = mutex.runExclusive(["/ws/docs/a.md"], async () => {
			order.push("first-start");
			await firstGate;
		});
		const second = mutex.runExclusive(["/ws/docs/../docs/a.md"], async () => {
			order.push("second-start");
		});

		await tick();
		assert.deepStrictEqual(order, ["first-start"]);

		releaseFirst();
		await Promise.all([first, second]);
		assert.deepStrictEqual(order, ["first-start", "second-start"]);
	});
});
