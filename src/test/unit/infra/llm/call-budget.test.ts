/**
 * @file call-budget.test.ts
 * @description AI を呼び過ぎたときの歯止めのテスト。
 *
 * 実測で見つかった暴走の回帰固定: 途中で切れた JSON を返す相手に 1 ファイルの翻訳を
 * 当てると、失敗の通知と訳し直しが輪になり、5 分で 116,838 回 AI を呼んだ
 * （意地悪シナリオ R1-N4）。輪そのものは塞いだが、次の輪が現れても請求が膨らむ前に
 * 止まることを、ここで固定しておく。
 */

import { strict as assert } from "node:assert";
import { OperationCancelledError } from "../../../../infra/errors/operation-cancelled";
import type { AIMessage, AIService } from "../../../../infra/llm/ai-service";
import {
	MAX_CONSECUTIVE_FAILURES,
	MAX_SAME_REQUEST,
	QUIET_RESET_MS,
	aiCallGuardState,
	isAiCallsStopped,
	resetAiCallGuard,
	setAiCallGuardClock,
	withAiCallGuard,
} from "../../../../infra/llm/call-budget";

/** 常に同じ答えを返す相手 */
function alwaysAnswers(answer = "ok"): AIService & { calls: number } {
	const service = {
		calls: 0,
		async sendMessage(): Promise<string> {
			service.calls++;
			return answer;
		},
	};
	return service;
}

/** 常に投げる相手 */
function alwaysThrows(error: () => Error): AIService & { calls: number } {
	const service = {
		calls: 0,
		async sendMessage(): Promise<string> {
			service.calls++;
			throw error();
		},
	};
	return service;
}

/** 送るたびに違う内容にする（ユニットごとに違う原稿を送っている状態） */
function messages(nth: number): AIMessage[] {
	return [{ role: "user", content: `unit ${nth}` }];
}

suite("AI 呼び出しの歯止め", () => {
	setup(() => {
		resetAiCallGuard();
	});

	teardown(() => {
		setAiCallGuardClock();
		resetAiCallGuard();
	});

	test("同じ内容を送り続けると打ち切る", async () => {
		const inner = alwaysAnswers();
		const guarded = withAiCallGuard(inner);

		let stopped = 0;
		for (let i = 0; i < MAX_SAME_REQUEST + 10; i++) {
			try {
				await guarded.sendMessage("system", messages(1));
			} catch (error) {
				if (!isAiCallsStopped(error)) throw error;
				stopped++;
			}
		}

		assert.equal(inner.calls, MAX_SAME_REQUEST, "上限までしか相手へ届いていないこと");
		assert.equal(stopped, 10, "上限を超えた分はすべて打ち切られていること");
	});

	test("送る内容が毎回違えば、何回呼んでも打ち切らない", async () => {
		const inner = alwaysAnswers();
		const guarded = withAiCallGuard(inner);

		for (let i = 0; i < MAX_SAME_REQUEST * 3; i++) {
			await guarded.sendMessage("system", messages(i));
		}

		assert.equal(inner.calls, MAX_SAME_REQUEST * 3, "大きなフォルダの翻訳を邪魔しないこと");
	});

	test("続けて失敗し続けると打ち切る", async () => {
		const inner = alwaysThrows(() => new Error("boom"));
		const guarded = withAiCallGuard(inner);

		let stopped = false;
		for (let i = 0; i < MAX_CONSECUTIVE_FAILURES + 5 && !stopped; i++) {
			try {
				await guarded.sendMessage("system", messages(i));
			} catch (error) {
				stopped = isAiCallsStopped(error);
			}
		}

		assert.equal(stopped, true, "失敗が続いたところで打ち切られること");
		assert.equal(inner.calls, MAX_CONSECUTIVE_FAILURES, "上限までしか相手へ届いていないこと");
	});

	test("途中で成功すれば、失敗の数え直しが起きる", async () => {
		let failNext = true;
		const inner: AIService & { calls: number } = {
			calls: 0,
			async sendMessage(): Promise<string> {
				inner.calls++;
				if (failNext) throw new Error("boom");
				return "ok";
			},
		};
		const guarded = withAiCallGuard(inner);

		for (let i = 0; i < MAX_CONSECUTIVE_FAILURES - 1; i++) {
			await guarded.sendMessage("system", messages(i)).catch(() => undefined);
		}
		assert.equal(aiCallGuardState().consecutiveFailures, MAX_CONSECUTIVE_FAILURES - 1);

		failNext = false;
		await guarded.sendMessage("system", messages(9999));
		assert.equal(aiCallGuardState().consecutiveFailures, 0, "成功したら 0 に戻ること");
	});

	test("呼び出しに時間がかかっても、待っていた時間として数え直さない", async () => {
		// 実測で見つかった弱点の回帰固定: 呼び始めた時刻だけを覚えていたため、1回の呼び出しに
		// QUIET_RESET_MS より長くかかる相手（実際の AI ではふつう）では毎回「間が空いた」と
		// 読めてしまい、失敗の数がまったく積み上がらなかった
		let fakeNow = 1_000_000;
		setAiCallGuardClock(() => fakeNow);
		const slowAndFailing: AIService = {
			async sendMessage(): Promise<string> {
				// 1回の呼び出しが「数え直す時間」より長くかかる
				fakeNow += QUIET_RESET_MS * 2;
				throw new Error("boom");
			},
		};
		const guarded = withAiCallGuard(slowAndFailing);

		for (let i = 0; i < 5; i++) {
			await guarded.sendMessage("system", messages(i)).catch(() => undefined);
		}

		assert.equal(aiCallGuardState().consecutiveFailures, 5, "遅い相手でも失敗が積み上がること");
	});

	test("しばらく呼ばずにいたら数え直す", async () => {
		let fakeNow = 1_000_000;
		setAiCallGuardClock(() => fakeNow);
		const inner = alwaysThrows(() => new Error("boom"));
		const guarded = withAiCallGuard(inner);

		for (let i = 0; i < 5; i++) {
			await guarded.sendMessage("system", messages(i)).catch(() => undefined);
		}
		assert.equal(aiCallGuardState().consecutiveFailures, 5);

		// 設定を直して、しばらく置いてから叩き直す
		fakeNow += QUIET_RESET_MS + 1;
		await guarded.sendMessage("system", messages(99)).catch(() => undefined);
		assert.equal(aiCallGuardState().consecutiveFailures, 1, "数え直したうえで1回ぶんだけ数えること");
	});

	test("人が止めた分は失敗に数えない", async () => {
		const inner = alwaysThrows(() => new OperationCancelledError("Translation cancelled"));
		const guarded = withAiCallGuard(inner);

		for (let i = 0; i < MAX_CONSECUTIVE_FAILURES + 5; i++) {
			await guarded.sendMessage("system", messages(i)).catch(() => undefined);
		}

		assert.equal(aiCallGuardState().consecutiveFailures, 0, "中断は数えないこと");
		assert.equal(inner.calls, MAX_CONSECUTIVE_FAILURES + 5, "止めたあとの実行が打ち切られないこと");
	});
});
