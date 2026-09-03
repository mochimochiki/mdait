import * as assert from "node:assert";
import {
	clampConcurrency,
	runWithConcurrency,
} from "../../../../commands/shared/concurrency";

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

suite("runWithConcurrency（セマフォ方式の並列実行）", () => {
	test("結果は入力と同じ順序で返る", async () => {
		const items = [30, 10, 20];
		const results = await runWithConcurrency(items, 3, async (ms) => {
			await delay(ms);
			return `done-${ms}`;
		});
		assert.deepStrictEqual(results, ["done-30", "done-10", "done-20"]);
	});

	test("同時実行数が上限を超えない", async () => {
		let running = 0;
		let maxRunning = 0;
		const items = Array.from({ length: 10 }, (_, i) => i);
		await runWithConcurrency(items, 3, async () => {
			running++;
			maxRunning = Math.max(maxRunning, running);
			await delay(10);
			running--;
		});
		assert.ok(maxRunning <= 3, `同時実行数が上限超過: ${maxRunning}`);
		assert.ok(maxRunning >= 2, `並列実行されていない: ${maxRunning}`);
	});

	test("limit=1 で逐次実行される", async () => {
		const order: number[] = [];
		await runWithConcurrency([1, 2, 3], 1, async (item) => {
			order.push(item);
			await delay(5);
		});
		assert.deepStrictEqual(order, [1, 2, 3]);
	});

	test("shouldStopがtrueになると新規着手を止める（実行中は完走）", async () => {
		let stop = false;
		const started: number[] = [];
		const results = await runWithConcurrency(
			[1, 2, 3, 4, 5],
			1,
			async (item) => {
				started.push(item);
				if (item === 2) {
					stop = true;
				}
				await delay(5);
				return item;
			},
			() => stop,
		);
		assert.deepStrictEqual(started, [1, 2]);
		// 未着手アイテムの結果は undefined
		assert.strictEqual(results[0], 1);
		assert.strictEqual(results[1], 2);
		assert.strictEqual(results[2], undefined);
	});

	test("空配列は即座に完了する", async () => {
		const results = await runWithConcurrency([], 3, async () => 1);
		assert.deepStrictEqual(results, []);
	});
});

suite("clampConcurrency", () => {
	test("未指定はデフォルト値", () => {
		assert.strictEqual(clampConcurrency(undefined), 3);
		assert.strictEqual(clampConcurrency(undefined, 1), 1);
	});

	test("1〜8にクランプされる", () => {
		assert.strictEqual(clampConcurrency(0), 1);
		assert.strictEqual(clampConcurrency(100), 8);
		assert.strictEqual(clampConcurrency(4), 4);
		assert.strictEqual(clampConcurrency(2.9), 2);
	});
});
