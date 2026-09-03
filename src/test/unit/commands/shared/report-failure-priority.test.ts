/**
 * @file report-failure-priority.test.ts
 * @description
 *   1回の実行で失敗が2種類起きたとき、どちらを伝えるかのテスト。
 *
 *   レビューで指摘を受けた欠陥の回帰固定: 「AI の答えが使えなかった」の通知を先に出して
 *   そこで打ち切っていたため、同じ実行で「書き戻せなかった」も起きていると、
 *   **訳した成果が失われたことと、その次の一手（同期を実行）が伝わらなかった**。
 *
 *   重さが違う。使えない答えは何も書いていないので、もう一度叩けば取り返せる。
 *   書き戻し失敗は訳した成果が消えている。だから重い方を先に出す。
 */

import { strict as assert } from "node:assert";
import { type TransOutcomeSummary, reportTransOutcome } from "../../../../commands/shared/guidance";

declare let __vscodeMockShownMessages:
	| Array<{ level: string; message: string; items: string[] }>
	| undefined;

function summary(overrides: Partial<TransOutcomeSummary> = {}): TransOutcomeSummary {
	return {
		outcome: "completed",
		translatedCount: 0,
		patchFailures: [],
		responseFailures: [],
		writeFailures: [],
		...overrides,
	};
}

function shown(): Array<{ level: string; message: string }> {
	return __vscodeMockShownMessages ?? [];
}

suite("失敗が重なったときにどちらを伝えるか", () => {
	setup(() => {
		__vscodeMockShownMessages = [];
	});

	teardown(() => {
		__vscodeMockShownMessages = undefined;
	});

	test("書き戻し失敗と使えない答えが同時に起きたら、書き戻し失敗を伝える", async () => {
		await reportTransOutcome(
			summary({
				translatedCount: 2,
				writeFailures: [{ title: "第1章", reason: "marker-not-found" }],
				responseFailures: [{ title: "第2章", reason: "truncated" }],
			}),
			{ label: "doc.md", retryFullTranslation: async () => undefined },
		);

		const messages = shown().map((m) => m.message);
		assert.equal(messages.length, 1, "通知は1本にまとめる");
		assert.ok(
			messages[0].includes("could not be written back"),
			`書き戻せなかったことを伝えること。出た文言: ${messages[0]}`,
		);
	});

	test("書き戻し失敗が無ければ、使えない答えを伝える", async () => {
		await reportTransOutcome(
			summary({
				responseFailures: [{ title: "第2章", reason: "truncated" }],
			}),
			{ label: "doc.md", retryFullTranslation: async () => undefined },
		);

		const messages = shown().map((m) => m.message);
		assert.equal(messages.length, 1);
		assert.ok(
			messages[0].includes("could not be used"),
			`使えない答えだったことを伝えること。出た文言: ${messages[0]}`,
		);
	});
});
