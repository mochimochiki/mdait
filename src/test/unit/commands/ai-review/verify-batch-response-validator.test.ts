import * as assert from "node:assert";
import { validateVerifyBatchResponse } from "../../../../commands/ai-review/verify-response-validator";

function entry(index: number, verdict = "match", confidence = 0.9): Record<string, unknown> {
	return { index, verdict, confidence, issues: [], reason: "x" };
}

suite("validateVerifyBatchResponse（バッチ検証応答のバリデーション）", () => {
	test("全 index が揃った応答は entries に全件入り error なし", () => {
		const result = validateVerifyBatchResponse(
			JSON.stringify({ results: [entry(1), entry(2, "partial", 0.8), entry(3, "mismatch")] }),
			[1, 2, 3],
		);
		assert.strictEqual(result.error, undefined);
		assert.strictEqual(result.entries.size, 3);
		assert.strictEqual(result.entries.get(1)?.verdict, "match");
		assert.strictEqual(result.entries.get(2)?.verdict, "partial");
		assert.strictEqual(result.entries.get(2)?.confidence, 0.8);
	});

	test("コードブロックで包まれた応答も抽出できる", () => {
		const result = validateVerifyBatchResponse(
			`\`\`\`json\n${JSON.stringify({ results: [entry(1)] })}\n\`\`\``,
			[1],
		);
		assert.strictEqual(result.error, undefined);
		assert.strictEqual(result.entries.get(1)?.verdict, "match");
	});

	test("JSONとして不正な応答は retryable エラー", () => {
		const result = validateVerifyBatchResponse("Everything looks fine.", [1, 2]);
		assert.strictEqual(result.entries.size, 0);
		assert.strictEqual(result.error?.code, "JSON_PARSE_ERROR");
		assert.strictEqual(result.error?.retryable, true);
	});

	test("results 欠落（単ペア形式の応答）は retryable エラー", () => {
		const result = validateVerifyBatchResponse(
			'{"verdict": "match", "confidence": 0.9, "issues": [], "reason": "x"}',
			[1],
		);
		assert.strictEqual(result.entries.size, 0);
		assert.strictEqual(result.error?.code, "INVALID_FIELD_TYPE");
		assert.strictEqual(result.error?.retryable, true);
	});

	test("index 欠落時は retryable エラーになるが有効エントリは保持される（部分受理用）", () => {
		const result = validateVerifyBatchResponse(JSON.stringify({ results: [entry(1), entry(3)] }), [1, 2, 3]);
		assert.strictEqual(result.error?.retryable, true);
		assert.ok(result.error?.message.includes("2"), "欠落 index がメッセージに含まれること");
		assert.strictEqual(result.entries.size, 2);
		assert.strictEqual(result.entries.get(1)?.verdict, "match");
		assert.strictEqual(result.entries.get(3)?.verdict, "match");
	});

	test("verdict 語彙外のエントリは無効として欠落扱いになる", () => {
		const result = validateVerifyBatchResponse(
			JSON.stringify({ results: [entry(1), entry(2, "ok")] }),
			[1, 2],
		);
		assert.strictEqual(result.entries.size, 1);
		assert.ok(result.error?.message.includes("2"));
	});

	test("重複 index は最初のエントリを採用する", () => {
		const result = validateVerifyBatchResponse(
			JSON.stringify({ results: [entry(1, "match"), entry(1, "mismatch")] }),
			[1],
		);
		assert.strictEqual(result.error, undefined);
		assert.strictEqual(result.entries.get(1)?.verdict, "match");
	});

	test("期待範囲外の index は無視される", () => {
		const result = validateVerifyBatchResponse(
			JSON.stringify({ results: [entry(1), entry(99)] }),
			[1],
		);
		assert.strictEqual(result.error, undefined);
		assert.strictEqual(result.entries.size, 1);
	});

	test("confidence は 0..1 にクランプされる", () => {
		const result = validateVerifyBatchResponse(
			JSON.stringify({ results: [entry(1, "match", 1.5), entry(2, "match", -0.2)] }),
			[1, 2],
		);
		assert.strictEqual(result.entries.get(1)?.confidence, 1);
		assert.strictEqual(result.entries.get(2)?.confidence, 0);
	});

	test("index が数値でないエントリは無視される", () => {
		const result = validateVerifyBatchResponse(
			JSON.stringify({ results: [{ ...entry(1), index: "1" }, entry(2)] }),
			[1, 2],
		);
		assert.strictEqual(result.entries.size, 1);
		assert.ok(result.error?.message.includes("1"));
	});
});
