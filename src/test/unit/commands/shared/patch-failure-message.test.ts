// パッチ失敗の理由を、原稿を書く人に伝わる言葉にできているかのテスト。
//
// 理由は `default` にまとめず全部並べる決まりになっている（まとめると、理由が増えたときに
// 無関係な説明が黙って出る）。ここでは「全部の理由に、それぞれ違う文がある」ことを固定する。
// とくに no-source-diff は、**黙って全文で訳し直して手直しを消していた経路**を
// 据え置きへ倒したときに使う理由なので、文言が無いと何が起きたか伝わらない。

import * as assert from "node:assert";
import { describePatchFailure } from "../../../../commands/shared/guidance";
import type { PatchFailureReason } from "../../../../core/diff/diff-generator";

// **理由を1つ足したらここも足さないとコンパイルが通らない形にする。**
// 以前はただの配列だったので、行番号方式で理由が3つ増えたときに列挙が置いていかれ、
// 「全部の理由に説明がある」ことを確かめているつもりで半分しか見ていなかった
const REASON_SET: Record<PatchFailureReason, true> = {
	"empty-patch": true,
	"unrecognized-format": true,
	"no-changes": true,
	"anchor-not-found": true,
	"no-source-diff": true,
	"unterminated-block": true,
	"bad-range": true,
	"overlapping-ops": true,
	"line-number-residue": true,
};
const ALL_REASONS = Object.keys(REASON_SET) as PatchFailureReason[];

suite("パッチ失敗の理由の伝え方", () => {
	test("どの理由にも空でない説明があること", () => {
		for (const reason of ALL_REASONS) {
			const message = describePatchFailure(reason);
			assert.ok(message.trim() !== "", `${reason} の説明が空`);
		}
	});

	test("理由ごとに違う説明であること（取り違えた説明が出ない）", () => {
		const messages = ALL_REASONS.map(describePatchFailure);
		assert.strictEqual(new Set(messages).size, ALL_REASONS.length, `重複: ${messages.join(" | ")}`);
	});

	test("行番号を本文へ書き戻したときは、そのことを言うこと", () => {
		// 当てはめには通るのに出来上がりが壊れる形なので、「形式が違う」と一緒くたにすると
		// 次の一手（もう一度翻訳を走らせる）が読めない
		const message = describePatchFailure("line-number-residue");
		assert.ok(message.includes("line numbers"), `行番号の書き戻しだと分かること: ${message}`);
	});

	test("旧原文が手元に無い場合は、そのことを言うこと", () => {
		const message = describePatchFailure("no-source-diff");
		assert.ok(
			message.includes("previous version of the source") && message.includes("which part changed"),
			`旧原文が無くて変更箇所を特定できなかったことを言うこと: ${message}`,
		);
	});
});
