import * as assert from "node:assert";
import { validateAlignResponse } from "../../../../commands/ai-sync/align-response-validator";

suite("validateAlignResponse（アライン応答のバリデーション）", () => {
	test('{"ok": true} を ok として解釈する', () => {
		const result = validateAlignResponse('{"ok": true}');
		assert.strictEqual(result.valid, true);
		assert.strictEqual(result.parsed?.kind, "ok");
	});

	test("空オブジェクトも ok として扱う", () => {
		const result = validateAlignResponse("{}");
		assert.strictEqual(result.valid, true);
		assert.strictEqual(result.parsed?.kind, "ok");
	});

	test("corrections を配列として解釈する", () => {
		const result = validateAlignResponse(
			'{"corrections": [{"sourceIndex": 5, "targetIndex": 4, "confidence": 0.9}]}',
		);
		assert.strictEqual(result.valid, true);
		assert.strictEqual(result.parsed?.kind, "corrections");
		if (result.parsed?.kind === "corrections") {
			assert.strictEqual(result.parsed.corrections.length, 1);
			assert.deepStrictEqual(result.parsed.corrections[0], {
				sourceIndex: 5,
				targetIndex: 4,
				confidence: 0.9,
			});
		}
	});

	test("confidence 欠落時は 0 を補う", () => {
		const result = validateAlignResponse('{"corrections": [{"sourceIndex": 1, "targetIndex": 2}]}');
		assert.strictEqual(result.valid, true);
		if (result.parsed?.kind === "corrections") {
			assert.strictEqual(result.parsed.corrections[0].confidence, 0);
		}
	});

	test("needBodies を refs として解釈する", () => {
		const result = validateAlignResponse('{"needBodies": [{"side": "source", "index": 3}]}');
		assert.strictEqual(result.valid, true);
		assert.strictEqual(result.parsed?.kind, "needBodies");
		if (result.parsed?.kind === "needBodies") {
			assert.deepStrictEqual(result.parsed.refs[0], { side: "source", index: 3 });
		}
	});

	test("```json フェンス付き応答からも抽出する", () => {
		const result = validateAlignResponse('```json\n{"ok": true}\n```');
		assert.strictEqual(result.valid, true);
		assert.strictEqual(result.parsed?.kind, "ok");
	});

	test("JSON不正はリトライ可能エラーを返す", () => {
		const result = validateAlignResponse("not json at all");
		assert.strictEqual(result.valid, false);
		assert.strictEqual(result.error?.retryable, true);
	});

	test("corrections の要素型不正はリトライ可能エラー", () => {
		const result = validateAlignResponse('{"corrections": [{"sourceIndex": "x", "targetIndex": 1}]}');
		assert.strictEqual(result.valid, false);
		assert.strictEqual(result.error?.retryable, true);
	});

	test("needBodies の side 不正はリトライ可能エラー", () => {
		const result = validateAlignResponse('{"needBodies": [{"side": "middle", "index": 1}]}');
		assert.strictEqual(result.valid, false);
		assert.strictEqual(result.error?.retryable, true);
	});
});
