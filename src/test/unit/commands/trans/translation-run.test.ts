import * as assert from "node:assert";
import {
	type UnitLoopPorts,
	type UnitTranslationOutcome,
	runUnitLoop,
} from "../../../../commands/trans/translation-run";
import { OperationCancelledError } from "../../../../infra/errors/operation-cancelled";

interface FakeUnit {
	name: string;
}

/** 呼び出し記録つきの口を組み立てる */
function makePorts(
	overrides: Partial<UnitLoopPorts<FakeUnit>> = {},
): UnitLoopPorts<FakeUnit> & { persisted: string[]; translated: string[] } {
	const persisted: string[] = [];
	const translated: string[] = [];
	const ports: UnitLoopPorts<FakeUnit> = {
		isCancelled: () => false,
		onProgress: () => {},
		translateUnit: async (unit) => {
			translated.push(unit.name);
			return { patched: false, tmHit: false } satisfies UnitTranslationOutcome;
		},
		persistUnit: async (unit) => {
			persisted.push(unit.name);
			return { written: true };
		},
		...overrides,
	};
	return Object.assign(ports, { persisted, translated });
}

const units: FakeUnit[] = [{ name: "u1" }, { name: "u2" }, { name: "u3" }];

suite("runUnitLoop（翻訳の進行制御）", () => {
	test("すべて成功すると全ユニットが翻訳・保存される", async () => {
		const ports = makePorts();
		const result = await runUnitLoop(units, ports);

		assert.strictEqual(result.translated, 3);
		assert.strictEqual(result.skipped, 0);
		assert.strictEqual(result.cancelled, false);
		assert.deepStrictEqual(ports.persisted, ["u1", "u2", "u3"]);
	});

	suite("中断（キャンセル）", () => {
		test("中断しても、そこまでに翻訳したユニットは保存済みとして残る", async () => {
			let done = 0;
			const ports = makePorts({
				// 1件終わった時点で中断を要求する
				isCancelled: () => done >= 1,
				translateUnit: async () => {
					done++;
					return { patched: false, tmHit: false };
				},
			});

			const result = await runUnitLoop(units, ports);

			assert.strictEqual(result.cancelled, true, "中断として扱われること");
			assert.strictEqual(result.translated, 1, "1件は訳し終えていること");
			assert.deepStrictEqual(ports.persisted, ["u1"], "訳した分は保存されること");
			assert.strictEqual(result.skipped, 2, "未着手は skipped に数えること");
		});

		test("翻訳の途中で中断例外が飛んでも失敗にはならない", async () => {
			const ports = makePorts({
				translateUnit: async (unit) => {
					if (unit.name === "u2") {
						throw new OperationCancelledError("Translation cancelled");
					}
					return { patched: false, tmHit: false };
				},
			});

			const result = await runUnitLoop(units, ports);

			assert.strictEqual(result.cancelled, true, "中断として扱われること");
			assert.strictEqual(result.error, undefined, "失敗として記録されないこと");
			assert.deepStrictEqual(ports.persisted, ["u1"], "中断前の成果は保存されること");
		});

		test("VS Code の CancellationError（name が Canceled）も中断として扱う", async () => {
			const canceled = new Error("Canceled");
			canceled.name = "Canceled";
			const ports = makePorts({
				translateUnit: async () => {
					throw canceled;
				},
			});

			const result = await runUnitLoop(units, ports);

			assert.strictEqual(result.cancelled, true);
			assert.strictEqual(result.error, undefined);
		});

		test("1件目の着手前に中断されたら何も翻訳しない", async () => {
			const ports = makePorts({ isCancelled: () => true });
			const result = await runUnitLoop(units, ports);

			assert.strictEqual(result.cancelled, true);
			assert.strictEqual(result.translated, 0);
			assert.strictEqual(result.skipped, 3);
			assert.deepStrictEqual(ports.translated, [], "AI 呼び出しに入らないこと");
		});
	});

	suite("パッチ適用の失敗", () => {
		test("パッチ失敗のユニットは訳文を据え置き、理由を記録して次へ進む", async () => {
			const ports = makePorts({
				translateUnit: async (unit) => {
					if (unit.name === "u2") {
						return { patched: false, tmHit: false, patchFailure: "anchor-not-found" };
					}
					return { patched: false, tmHit: false };
				},
			});

			const result = await runUnitLoop(units, ports);

			assert.strictEqual(result.cancelled, false, "処理は止まらないこと");
			assert.strictEqual(result.translated, 2, "失敗したユニットは翻訳に数えないこと");
			assert.strictEqual(result.skipped, 1);
			assert.strictEqual(result.patchFailures.length, 1);
			assert.strictEqual(result.patchFailures[0].reason, "anchor-not-found");
			assert.strictEqual(result.patchFailures[0].unit.name, "u2");
			assert.deepStrictEqual(
				ports.persisted,
				["u1", "u3"],
				"据え置いたユニットは書き戻さないこと",
			);
		});

		test("パッチ失敗が続いても、途中で止まらず最後まで処理する", async () => {
			const ports = makePorts({
				translateUnit: async () => ({
					patched: false,
					tmHit: false,
					patchFailure: "empty-patch" as const,
				}),
			});

			const result = await runUnitLoop(units, ports);

			assert.strictEqual(result.patchFailures.length, 3, "3件すべて記録されること");
			assert.strictEqual(result.translated, 0);
			assert.deepStrictEqual(ports.persisted, []);
		});
	});

	suite("失敗", () => {
		test("翻訳が失敗すると打ち切るが、そこまでの成果は保存済みとして残る", async () => {
			const boom = new Error("AI unavailable");
			const ports = makePorts({
				translateUnit: async (unit) => {
					if (unit.name === "u2") {
						throw boom;
					}
					return { patched: false, tmHit: false };
				},
			});

			const result = await runUnitLoop(units, ports);

			assert.strictEqual(result.error, boom, "失敗の原因が返ること");
			assert.strictEqual(result.errorUnit?.name, "u2");
			assert.strictEqual(result.cancelled, false, "中断とは区別されること");
			assert.deepStrictEqual(ports.persisted, ["u1"], "失敗前の成果は保存されること");
		});

		test("例外は投げず、呼び出し側が保存してから報告できるようにする", async () => {
			const ports = makePorts({
				translateUnit: async () => {
					throw new Error("boom");
				},
			});

			// throw しないことそのものが要件（呼び出し側の finally で保存させるため）
			const result = await runUnitLoop(units, ports);
			assert.ok(result.error, "失敗は結果に載せて返すこと");
		});
	});

	suite("書き戻しの失敗", () => {
		test("書き戻せなかったユニットは記録され、処理は続く", async () => {
			const ports = makePorts({
				persistUnit: async (unit) => {
					if (unit.name === "u2") {
						return { written: false, reason: "marker-not-found" };
					}
					return { written: true };
				},
			});

			const result = await runUnitLoop(units, ports);

			assert.strictEqual(result.writeFailures.length, 1);
			assert.strictEqual(result.writeFailures[0].unit.name, "u2");
			assert.strictEqual(result.writeFailures[0].reason, "marker-not-found");
			assert.strictEqual(result.translated, 3, "翻訳自体は成功していること");
		});
	});

	test("対象が0件なら何も起きず、中断でも失敗でもない", async () => {
		const ports = makePorts();
		const result = await runUnitLoop([], ports);

		assert.strictEqual(result.processed, 0);
		assert.strictEqual(result.translated, 0);
		assert.strictEqual(result.cancelled, false);
		assert.strictEqual(result.error, undefined);
	});
});
