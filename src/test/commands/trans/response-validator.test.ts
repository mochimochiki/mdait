/**
 * @file response-validator.test.ts
 * @description ResponseValidatorのテスト実装
 * AIレスポンスのバリデーションロジックの検証
 */

import { strict as assert } from "node:assert";
import {
	detectJsonInContent,
	extractJsonFromResponse,
	validateRevisionPatchResponse,
	validateTranslationResponse,
} from "../../../commands/trans/response-validator";

suite("ResponseValidator", () => {
	suite("extractJsonFromResponse", () => {
		test("生のJSONを抽出できる", () => {
			const raw = '{"translation": "テスト"}';
			const result = extractJsonFromResponse(raw);
			assert.strictEqual(result, '{"translation": "テスト"}');
		});

		test("マークダウンコードブロックからJSONを抽出できる", () => {
			const raw = '```json\n{"translation": "テスト"}\n```';
			const result = extractJsonFromResponse(raw);
			assert.strictEqual(result, '{"translation": "テスト"}');
		});

		test("言語指定なしのコードブロックからJSONを抽出できる", () => {
			const raw = '```\n{"translation": "テスト"}\n```';
			const result = extractJsonFromResponse(raw);
			assert.strictEqual(result, '{"translation": "テスト"}');
		});

		test("前後の空白をトリムする", () => {
			const raw = '  {"translation": "テスト"}  ';
			const result = extractJsonFromResponse(raw);
			assert.strictEqual(result, '{"translation": "テスト"}');
		});
	});

	suite("detectJsonInContent", () => {
		test("通常のテキストはJSON検出しない", () => {
			const text = "これは通常の翻訳されたテキストです。";
			const result = detectJsonInContent(text);
			assert.strictEqual(result.detected, false);
		});

		test("translation ラッパーを検出する", () => {
			const text = '{"translation": "ネストされた翻訳"}';
			const result = detectJsonInContent(text);
			assert.strictEqual(result.detected, true);
			assert.ok(result.pattern?.includes("wrapper"));
		});

		test("targetPatch ラッパーを検出する", () => {
			const text = '{"targetPatch": "--- content\\n+++ content"}';
			const result = detectJsonInContent(text);
			assert.strictEqual(result.detected, true);
			assert.ok(result.pattern?.includes("wrapper"));
		});

		test("行頭のJSONオブジェクトを検出する", () => {
			const text = '{"key": "value"}';
			const result = detectJsonInContent(text);
			assert.strictEqual(result.detected, true);
			assert.ok(result.pattern?.includes("JSON object"));
		});

		test("エスケープされたJSONを検出する", () => {
			const text = 'テキスト \\"key\\": \\"value\\" テキスト';
			const result = detectJsonInContent(text);
			assert.strictEqual(result.detected, true);
			assert.ok(result.pattern?.includes("Escaped"));
		});

		test("中括弧を含む通常のテキストは誤検出しない", () => {
			const text = "これは{テスト}です。波括弧は普通のテキストです。";
			const result = detectJsonInContent(text);
			assert.strictEqual(result.detected, false);
		});
	});

	suite("validateTranslationResponse", () => {
		test("正しいJSON形式を受け入れる", () => {
			const raw = '{"translation": "翻訳されたテキスト", "termSuggestions": []}';
			const result = validateTranslationResponse(raw);
			assert.strictEqual(result.valid, true);
			assert.strictEqual(result.parsed?.translation, "翻訳されたテキスト");
		});

		test("termSuggestionsなしでも有効", () => {
			const raw = '{"translation": "翻訳されたテキスト"}';
			const result = validateTranslationResponse(raw);
			assert.strictEqual(result.valid, true);
			assert.strictEqual(result.parsed?.translation, "翻訳されたテキスト");
		});

		test("termSuggestionsが正しくパースされる", () => {
			const raw = JSON.stringify({
				translation: "翻訳されたテキスト",
				termSuggestions: [{ source: "test", target: "テスト", context: "this is a test" }],
			});
			const result = validateTranslationResponse(raw);
			assert.strictEqual(result.valid, true);
			assert.strictEqual(result.parsed?.termSuggestions?.length, 1);
			assert.strictEqual(result.parsed?.termSuggestions?.[0].source, "test");
		});

		test("warningsが正しくパースされる", () => {
			const raw = '{"translation": "翻訳されたテキスト", "warnings": ["警告1", "警告2"]}';
			const result = validateTranslationResponse(raw);
			assert.strictEqual(result.valid, true);
			assert.strictEqual(result.parsed?.warnings?.length, 2);
		});

		test("JSONパースエラーを検出する", () => {
			const raw = "これはJSONではありません";
			const result = validateTranslationResponse(raw);
			assert.strictEqual(result.valid, false);
			assert.strictEqual(result.error?.code, "JSON_PARSE_ERROR");
			assert.strictEqual(result.error?.retryable, true);
		});

		test("不正なJSONを検出する", () => {
			const raw = '{"translation": "閉じていない';
			const result = validateTranslationResponse(raw);
			assert.strictEqual(result.valid, false);
			assert.strictEqual(result.error?.code, "JSON_PARSE_ERROR");
		});

		test("translation フィールド欠落を検出する", () => {
			const raw = '{"text": "翻訳されたテキスト"}';
			const result = validateTranslationResponse(raw);
			assert.strictEqual(result.valid, false);
			assert.strictEqual(result.error?.code, "MISSING_REQUIRED_FIELD");
			assert.strictEqual(result.error?.retryable, true);
		});

		test("translation フィールドが文字列でない場合を検出する", () => {
			const raw = '{"translation": 123}';
			const result = validateTranslationResponse(raw);
			assert.strictEqual(result.valid, false);
			assert.strictEqual(result.error?.code, "MISSING_REQUIRED_FIELD");
		});

		test("配列レスポンスを拒否する", () => {
			const raw = '["翻訳されたテキスト"]';
			const result = validateTranslationResponse(raw);
			assert.strictEqual(result.valid, false);
			assert.strictEqual(result.error?.code, "INVALID_FIELD_TYPE");
		});

		test("translation内のJSON混入を検出する（パターンA: ラッパー構造）", () => {
			const raw = '{"translation": "{\\"translation\\": \\"ネストされた翻訳\\"}"}';
			// Note: JSONパース後の値は {"translation": "ネストされた翻訳"} という文字列になる
			const result = validateTranslationResponse(raw);
			assert.strictEqual(result.valid, false);
			assert.strictEqual(result.error?.code, "JSON_IN_CONTENT");
		});

		test("マークダウンコードブロック付きレスポンスを処理できる", () => {
			const raw = '```json\n{"translation": "翻訳されたテキスト"}\n```';
			const result = validateTranslationResponse(raw);
			assert.strictEqual(result.valid, true);
			assert.strictEqual(result.parsed?.translation, "翻訳されたテキスト");
		});
	});

	suite("validateRevisionPatchResponse", () => {
		test("正しいJSON形式を受け入れる", () => {
			const raw = '{"targetPatch": "--- content\\n+++ content\\n@@ -1 +1 @@\\n-old\\n+new"}';
			const result = validateRevisionPatchResponse(raw);
			assert.strictEqual(result.valid, true);
			assert.ok(result.parsed?.targetPatch.includes("--- content"));
		});

		test("termSuggestionsとwarningsが正しくパースされる", () => {
			const raw = JSON.stringify({
				targetPatch: "--- content\n+++ content",
				termSuggestions: [{ source: "test", target: "テスト", context: "this is a test" }],
				warnings: ["パッチ適用時に注意"],
			});
			const result = validateRevisionPatchResponse(raw);
			assert.strictEqual(result.valid, true);
			assert.strictEqual(result.parsed?.termSuggestions?.length, 1);
			assert.strictEqual(result.parsed?.warnings?.length, 1);
		});

		test("targetPatch フィールド欠落を検出する", () => {
			const raw = '{"patch": "--- content"}';
			const result = validateRevisionPatchResponse(raw);
			assert.strictEqual(result.valid, false);
			assert.strictEqual(result.error?.code, "MISSING_REQUIRED_FIELD");
			assert.strictEqual(result.error?.retryable, true);
		});

		test("targetPatch フィールドが文字列でない場合を検出する", () => {
			const raw = '{"targetPatch": ["line1", "line2"]}';
			const result = validateRevisionPatchResponse(raw);
			assert.strictEqual(result.valid, false);
			assert.strictEqual(result.error?.code, "MISSING_REQUIRED_FIELD");
		});

		test("targetPatch内のJSON混入を検出する", () => {
			const raw = '{"targetPatch": "{\\"targetPatch\\": \\"ネストされたパッチ\\"}"}';
			const result = validateRevisionPatchResponse(raw);
			assert.strictEqual(result.valid, false);
			assert.strictEqual(result.error?.code, "JSON_IN_CONTENT");
		});

		test("JSONパースエラーを検出する", () => {
			const raw = "これはJSONではありません";
			const result = validateRevisionPatchResponse(raw);
			assert.strictEqual(result.valid, false);
			assert.strictEqual(result.error?.code, "JSON_PARSE_ERROR");
		});
	});
});
