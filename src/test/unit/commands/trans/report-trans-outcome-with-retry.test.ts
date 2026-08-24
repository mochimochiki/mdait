/**
 * @file report-trans-outcome-with-retry.test.ts
 * @description 「全文で訳し直す」を選んだあとの返り値のテスト。
 *
 * 実測で見つかった欠陥の回帰固定: 差分の当てはめに失敗 → 確認に「全文で訳し直す」と
 * 答えると、訳文は正しく書き換わりハッシュも need も進むのに、返り値はやり直し前の
 * 「0件翻訳・1件スキップ」のままだった。返り値を読む側（LM ツール・ステータスツリー・
 * lab の IPC）が「1件飛ばした、何も訳していない」と受け取ってしまう。
 */

import { strict as assert } from "node:assert";
import { type TransCommandResult, reportTransOutcomeWithRetry } from "../../../../commands/trans/trans-command";

declare let __vscodeMockShownMessages: Array<{ level: string; message: string; items: string[] }> | undefined;
declare let __vscodeMockMessageChoice: unknown;

/** 差分の当てはめに失敗し、訳文を据え置いた結果 */
function patchFailedResult(): TransCommandResult {
	return {
		outcome: "completed",
		unitCount: 1,
		translatedCount: 0,
		patchedCount: 0,
		skippedCount: 1,
		tmHits: 0,
		patchFailures: [{ unitHash: "abc12345", title: "Section", reason: "anchor-not-found" }],
		responseFailures: [],
		writeFailures: [],
	};
}

/** 全文で訳し直して成功した結果 */
function retriedResult(): TransCommandResult {
	return {
		outcome: "completed",
		unitCount: 1,
		translatedCount: 1,
		patchedCount: 0,
		skippedCount: 0,
		tmHits: 0,
		patchFailures: [],
		responseFailures: [],
		writeFailures: [],
	};
}

/**
 * ボタン付き通知に「1枚目は訳し直す・2枚目（モーダルの確認）は進める」と答える。
 * items には modal オプションのオブジェクトも混ざるので、文字列だけを見る。
 */
function answerRetryThenConfirm(): void {
	__vscodeMockMessageChoice = ({ items }: { items: unknown[] }) =>
		items.find((item): item is string => typeof item === "string" && item.includes("Re-translate"));
}

suite("reportTransOutcomeWithRetry", () => {
	setup(() => {
		__vscodeMockShownMessages = [];
	});

	teardown(() => {
		__vscodeMockShownMessages = undefined;
		__vscodeMockMessageChoice = undefined;
	});

	test("全文で訳し直したときは、やり直した側の結果を呼び手に返す", async () => {
		answerRetryThenConfirm();
		let retried = 0;

		const result = await reportTransOutcomeWithRetry(patchFailedResult(), "guide.md", async () => {
			retried++;
			return retriedResult();
		});

		assert.equal(retried, 1, "やり直しが1回だけ起きること");
		assert.equal(result.translatedCount, 1, "訳した件数が実態と一致すること");
		assert.equal(result.skippedCount, 0, "飛ばした件数が実態と一致すること");
		assert.equal(result.patchFailures.length, 0, "据え置いたユニットが残っていないこと");
	});

	test("やり直しが結果を返さなかったときは、やり直す前の結果を保つ", async () => {
		answerRetryThenConfirm();

		const result = await reportTransOutcomeWithRetry(patchFailedResult(), "guide.md", async () => undefined);

		assert.equal(result.skippedCount, 1);
		assert.equal(result.patchFailures.length, 1);
	});

	test("訳し直しを選ばなかったときは、やり直さず元の結果を返す", async () => {
		__vscodeMockMessageChoice = undefined;
		let retried = 0;

		const result = await reportTransOutcomeWithRetry(patchFailedResult(), "guide.md", async () => {
			retried++;
			return retriedResult();
		});

		assert.equal(retried, 0, "やり直していないこと");
		assert.equal(result.translatedCount, 0);
		assert.equal(result.skippedCount, 1);
	});
});
