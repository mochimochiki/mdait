/**
 * @file report-response-failure.test.ts
 * @description
 *   AI の答えが使えなかったときの通知のテスト。
 *
 *   実測で見つかった欠陥の回帰固定: 途中で切れた JSON や空の応答を受けても
 *   「Translation completed for doc.md: 1 unit(s).」と成功として報告していた。
 *   翻訳は1件も成立しておらず、訳文には応答の生テキストが書かれていたのに、である。
 *
 *   ここで固定するのは「成功と区別が付くこと」だけ。原稿を触らないことは
 *   translation-run（進行制御）と translator（検証）の側で固定している。
 */

import { strict as assert } from "node:assert";
import {
	type TransOutcomeSummary,
	reportTransOutcome,
} from "../../../../commands/shared/guidance";

declare let __vscodeMockShownMessages:
	| Array<{ level: string; message: string; items: string[] }>
	| undefined;

/** 通知に必要な最小限の結果を作る */
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

suite("使えない答えを受けたときの通知", () => {
	setup(() => {
		__vscodeMockShownMessages = [];
	});

	teardown(() => {
		__vscodeMockShownMessages = undefined;
	});

	test("1件も訳せなかったときは、成功ではなく警告として伝えること", async () => {
		await reportTransOutcome(
			summary({
				outcome: "failed",
				translatedCount: 0,
				responseFailures: [{ title: "見出しA", reason: "invalid-format" }],
			}),
			{ label: "doc.md" },
		);

		assert.equal(shown().length, 1, "黙って終わらないこと");
		assert.equal(shown()[0].level, "warning");
		assert.ok(
			!shown()[0].message.includes("Translation completed"),
			"「翻訳できました」と言わないこと",
		);
		assert.ok(
			shown()[0].message.includes("still need translation"),
			"まだ訳されていないことを伝えること",
		);
	});

	test("何も書いていないのに「訳すものが無かった」と言わないこと", async () => {
		await reportTransOutcome(
			summary({
				outcome: "failed",
				translatedCount: 0,
				responseFailures: [{ title: "見出しA", reason: "empty" }],
			}),
			{ label: "doc.md" },
		);

		assert.ok(
			!shown()[0].message.includes("Nothing to translate"),
			"訳す対象が無かったのではなく、訳せなかったのだと伝えること",
		);
	});

	test("一部だけ訳せたときは、訳せた数と訳せなかった数の両方を伝えること", async () => {
		await reportTransOutcome(
			summary({
				translatedCount: 2,
				responseFailures: [{ title: "見出しC", reason: "truncated" }],
			}),
			{ label: "doc.md" },
		);

		assert.equal(shown()[0].level, "warning");
		assert.ok(shown()[0].message.includes("2"), "訳せた数が出ること");
		assert.ok(shown()[0].message.includes("1"), "訳せなかった数が出ること");
	});

	test("途中で切れたときは、上限を上げるという次の一手を出すこと", async () => {
		await reportTransOutcome(
			summary({
				outcome: "failed",
				responseFailures: [{ title: "見出しA", reason: "truncated" }],
			}),
			{ label: "doc.md" },
		);

		assert.ok(
			shown()[0].message.includes("maxTokens"),
			"どの設定を触ればよいかを伝えること",
		);
	});

	test("使えない答えが無ければ、これまでどおり成功として報告すること", async () => {
		await reportTransOutcome(summary({ translatedCount: 3 }), { label: "doc.md" });

		assert.equal(shown()[0].level, "info");
		assert.ok(shown()[0].message.includes("Translation completed"));
	});
});
