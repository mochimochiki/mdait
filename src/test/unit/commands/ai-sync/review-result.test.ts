import * as assert from "node:assert";
import {
	type ParsedVerifyResponse,
	decideReviewAction,
	formatReviewReason,
} from "../../../../commands/ai-sync/review-result";

function response(overrides: Partial<ParsedVerifyResponse> = {}): ParsedVerifyResponse {
	return {
		verdict: "match",
		confidence: 0.95,
		issues: [],
		reason: "Faithful and complete translation.",
		...overrides,
	};
}

const defaultPolicy = { autoApprove: true, threshold: 0.9 };

suite("decideReviewAction（判定→アクションの純関数）", () => {
	test("match かつ閾値以上かつ autoApprove 有効なら approve", () => {
		assert.strictEqual(decideReviewAction(response(), defaultPolicy), "approve");
	});

	test("match でも confidence が閾値未満なら keep", () => {
		assert.strictEqual(decideReviewAction(response({ confidence: 0.7 }), defaultPolicy), "keep");
	});

	test("match でも autoApprove 無効なら keep", () => {
		assert.strictEqual(decideReviewAction(response(), { autoApprove: false, threshold: 0.9 }), "keep");
	});

	test("match でも issues がある場合は keep（三重条件）", () => {
		assert.strictEqual(
			decideReviewAction(response({ issues: ["terminology inconsistency"] }), defaultPolicy),
			"keep",
		);
	});

	test("mismatch は confidence にかかわらず escalate", () => {
		assert.strictEqual(decideReviewAction(response({ verdict: "mismatch", confidence: 0.99 }), defaultPolicy), "escalate");
	});

	test("partial は escalate", () => {
		assert.strictEqual(
			decideReviewAction(response({ verdict: "partial", issues: ["omission: last paragraph"] }), defaultPolicy),
			"escalate",
		);
	});

	test("uncertain は keep", () => {
		assert.strictEqual(decideReviewAction(response({ verdict: "uncertain", confidence: 0 }), defaultPolicy), "keep");
	});

	test("閾値ちょうどの confidence は approve（境界値）", () => {
		assert.strictEqual(decideReviewAction(response({ confidence: 0.9 }), defaultPolicy), "approve");
	});
});

suite("formatReviewReason（hover向け判定サマリ）", () => {
	test("verdict・confidence・reason を含む文字列を生成する", () => {
		const text = formatReviewReason(response({ verdict: "mismatch", confidence: 0.85, reason: "Different topics." }));
		assert.ok(text.includes("mismatch"));
		assert.ok(text.includes("0.85"));
		assert.ok(text.includes("Different topics."));
	});

	test("issues がある場合は末尾に列挙される", () => {
		const text = formatReviewReason(response({ issues: ["omission: intro", "extra: footer"] }));
		assert.ok(text.includes("omission: intro; extra: footer"));
	});
});
