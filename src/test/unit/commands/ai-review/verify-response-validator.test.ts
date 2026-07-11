import * as assert from "node:assert";
import { validateVerifyResponse } from "../../../../commands/ai-review/verify-response-validator";

suite("validateVerifyResponse（AI翻訳レビュー応答のバリデーション）", () => {
	test("正しいJSON応答をパースして verdict と confidence を返す", () => {
		const result = validateVerifyResponse(
			'{"verdict": "match", "confidence": 0.95, "issues": [], "reason": "Complete translation."}',
		);
		assert.strictEqual(result.valid, true);
		assert.strictEqual(result.parsed?.verdict, "match");
		assert.strictEqual(result.parsed?.confidence, 0.95);
		assert.deepStrictEqual(result.parsed?.issues, []);
		assert.strictEqual(result.parsed?.reason, "Complete translation.");
	});

	test("コードブロックで包まれたJSONを抽出できる", () => {
		const result = validateVerifyResponse(
			'```json\n{"verdict": "partial", "confidence": 0.8, "issues": ["omission"], "reason": "Missing part."}\n```',
		);
		assert.strictEqual(result.valid, true);
		assert.strictEqual(result.parsed?.verdict, "partial");
		assert.deepStrictEqual(result.parsed?.issues, ["omission"]);
	});

	test("JSONとして不正な応答は retryable エラーになる", () => {
		const result = validateVerifyResponse("The translation looks fine to me.");
		assert.strictEqual(result.valid, false);
		assert.strictEqual(result.error?.code, "JSON_PARSE_ERROR");
		assert.strictEqual(result.error?.retryable, true);
	});

	test("verdict が語彙外の場合は retryable エラーになる", () => {
		const result = validateVerifyResponse('{"verdict": "ok", "confidence": 0.9, "issues": [], "reason": "x"}');
		assert.strictEqual(result.valid, false);
		assert.strictEqual(result.error?.code, "INVALID_FIELD_TYPE");
		assert.strictEqual(result.error?.retryable, true);
	});

	test("confidence が欠落している場合は retryable エラーになる", () => {
		const result = validateVerifyResponse('{"verdict": "match", "issues": [], "reason": "x"}');
		assert.strictEqual(result.valid, false);
		assert.strictEqual(result.error?.code, "MISSING_REQUIRED_FIELD");
		assert.strictEqual(result.error?.retryable, true);
	});

	test("confidence が文字列の場合は retryable エラーになる", () => {
		const result = validateVerifyResponse('{"verdict": "match", "confidence": "high", "issues": [], "reason": "x"}');
		assert.strictEqual(result.valid, false);
		assert.strictEqual(result.error?.retryable, true);
	});

	test("範囲外の confidence は 0..1 にクランプされる", () => {
		const over = validateVerifyResponse('{"verdict": "match", "confidence": 1.5, "issues": [], "reason": "x"}');
		assert.strictEqual(over.parsed?.confidence, 1);
		const under = validateVerifyResponse('{"verdict": "match", "confidence": -0.2, "issues": [], "reason": "x"}');
		assert.strictEqual(under.parsed?.confidence, 0);
	});

	test("issues と reason の省略は空値として扱われる", () => {
		const result = validateVerifyResponse('{"verdict": "uncertain", "confidence": 0.3}');
		assert.strictEqual(result.valid, true);
		assert.deepStrictEqual(result.parsed?.issues, []);
		assert.strictEqual(result.parsed?.reason, "");
	});

	test("issues 内の非文字列要素は除外される", () => {
		const result = validateVerifyResponse(
			'{"verdict": "partial", "confidence": 0.8, "issues": ["valid", 42, null], "reason": "x"}',
		);
		assert.deepStrictEqual(result.parsed?.issues, ["valid"]);
	});
});
