/**
 * @file ai-json.test.ts
 * @description AI の答えから JSON を読む1つの入口のテスト。
 *
 * ここが厳しすぎると、読めるはずの答えを「使えない」と突き返して仕事が止まる。
 * 緩すぎると、読めなかった答えを 0 件として飲み込む（ADR-260908-03）。
 * その両側を固定する。
 */

import { strict as assert } from "node:assert";
import { parseJsonAnswer } from "../../../../commands/shared/ai-json";
import { UnusableAIResponseError } from "../../../../infra/llm/unusable-response";

const rejectsWith = async (response: string, reason: string, why: string) => {
	assert.throws(
		() => parseJsonAnswer(response, "Test"),
		(error: unknown) => error instanceof UnusableAIResponseError && error.reason === reason,
		why,
	);
};

suite("parseJsonAnswer", () => {
	test("素の JSON をそのまま読む", () => {
		assert.deepEqual(parseJsonAnswer('[{"a":1}]', "Test"), [{ a: 1 }]);
		assert.deepEqual(parseJsonAnswer('{"a":1}', "Test"), { a: 1 });
	});

	test("コードフェンスの中を読む（前置き・後書きは落とす）", () => {
		const response = 'ここに結果があります。\n```json\n[{"a":1}]\n```\n**補足:** 以上。';
		assert.deepEqual(parseJsonAnswer(response, "Test"), [{ a: 1 }]);
	});

	test("説明文に挟まれていても読む", () => {
		assert.deepEqual(parseJsonAnswer('結果:\n[{"a":1}]\n以上。', "Test"), [{ a: 1 }]);
	});

	test("入れ子の配列を途中で切らない", () => {
		// 最初の `]` で切ると必ず壊れる形（用語の答えはこれ）
		const response = 'まとめ:\n[{"variants":["x","y"],"term":"z"}]\n以上。';
		assert.deepEqual(parseJsonAnswer(response, "Test"), [{ variants: ["x", "y"], term: "z" }]);
	});

	test("本文が空なら empty として断ち切る", async () => {
		await rejectsWith("", "empty", "空文字は empty であること");
		await rejectsWith("   \n\t ", "empty", "空白だけでも empty であること");
	});

	test("JSON として読めなければ invalid-format として断ち切る", async () => {
		await rejectsWith("no json here", "invalid-format", "JSON が無ければ断ち切ること");
		await rejectsWith('[{"a": 1', "invalid-format", "途中で切れていれば断ち切ること");
	});

	test("空の配列・空のオブジェクトは正しい答えとして読む", () => {
		assert.deepEqual(parseJsonAnswer("[]", "Test"), []);
		assert.deepEqual(parseJsonAnswer("{}", "Test"), {});
	});
});
