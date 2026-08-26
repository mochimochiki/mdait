// パッチ失敗の理由を、原稿を書く人に伝わる言葉にできているかのテスト。
//
// 理由は `default` にまとめず全部並べる決まりになっている（まとめると、理由が増えたときに
// 無関係な説明が黙って出る）。ここでは「全部の理由に、それぞれ違う文がある」ことを固定する。
// とくに no-source-diff は、**黙って全文で訳し直して手直しを消していた経路**を
// 据え置きへ倒したときに使う理由なので、文言が無いと何が起きたか伝わらない。

import * as assert from "node:assert";
import { describePatchFailure } from "../../../../commands/shared/guidance";
import type { PatchFailureReason } from "../../../../core/diff/diff-generator";

const ALL_REASONS: PatchFailureReason[] = [
	"empty-patch",
	"unrecognized-format",
	"no-changes",
	"anchor-not-found",
	"no-source-diff",
];

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

	test("旧原文が手元に無い場合は、そのことを言うこと", () => {
		const message = describePatchFailure("no-source-diff");
		assert.ok(
			message.includes("previous version of the source") && message.includes("which part changed"),
			`旧原文が無くて変更箇所を特定できなかったことを言うこと: ${message}`,
		);
	});
});
