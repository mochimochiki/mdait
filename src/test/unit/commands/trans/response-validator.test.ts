/**
 * @file response-validator.test.ts
 * @description ResponseValidatorのテスト実装
 * AIレスポンスのバリデーションロジックの検証
 */

import { strict as assert } from "node:assert";
import {
	detectJsonInContent,
	extractJsonFromResponse,
	sanitizeTermSuggestions,
	validateRevisionPatchPlainResponse,
	validateRevisionPatchResponse,
	validateTranslationResponse,
} from "../../../../commands/trans/response-validator";

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

/**
 * 行番号方式の答えを、当てる前に確かめる（ADR-260903-01 / ADR-260908-05）。
 *
 * ここで落としたものは**同じ形式のまま聞き直せる**。当てはめの段まで持って行くと
 * 訳文を据え置いて利用者に投げ返すことになるので、気づける失敗は手前で気づく。
 */
suite("行番号方式の答えの検証", () => {
	test("編集ブロックが1つでもあれば受け入れる", () => {
		const result = validateRevisionPatchPlainResponse("REPLACE 4\n- Real-time sync\nEND");
		assert.strictEqual(result.valid, true);
		assert.strictEqual(result.parsed?.targetPatch, "REPLACE 4\n- Real-time sync\nEND");
	});

	test("編集ブロックが1つも無ければ、やり直せる失敗として返す", () => {
		const result = validateRevisionPatchPlainResponse("ここを直しました。");
		assert.strictEqual(result.valid, false);
		assert.strictEqual(result.error?.retryable, true);
	});

	test("JSON で返してきたら、やり直せる失敗として返す", () => {
		const result = validateRevisionPatchPlainResponse('{"targetPatch": "REPLACE 4\\n- x\\nEND"}');
		assert.strictEqual(result.valid, false);
		assert.strictEqual(result.error?.code, "JSON_IN_CONTENT");
	});

	test("渡した行番号を本文へ書き戻していたら、当てる前に聞き直す", () => {
		// 当てはめ器から見れば正しいパッチなので、ここで気づかないと
		// `4\t- Real-time sync` がそのまま訳文として保存される（実測で1件出た形）
		const result = validateRevisionPatchPlainResponse("REPLACE 4\n4\t- Real-time sync\nEND");
		assert.strictEqual(result.valid, false);
		assert.strictEqual(result.error?.retryable, true);
		assert.match(String(result.error?.message), /line numbers/);
	});

	test("1列目が数字のタブ区切りデータは巻き込まない", () => {
		const result = validateRevisionPatchPlainResponse("REPLACE 3\n2\tblueberry\nEND");
		assert.strictEqual(result.valid, true);
	});
});

/**
 * AI が返した用語候補の形を、受け手に渡す前に確かめる。
 *
 * 背景: 以前は「配列かどうか」しか見ずに `TermSuggestion[]` として通していた。実測
 * （haiku・対訳47ファイルの見本サイトの改訂）で `source` の無い候補が返り、受け手の
 * `candidate.source.toLowerCase()` が **TypeError でファイル1本の翻訳ごと落とした**
 * （`reference/plugins.md`。訳文は1文字も書かれず、need も外れないまま残った）。
 * 型が「必ずある」と言っているのに、その保証をどこも作っていなかった。
 *
 * 直し方の要点は、**壊れた候補だけを落として翻訳は通す**こと。用語候補は翻訳の応答に
 * 相乗りしているおまけなので、応答ごと捨てると良い訳文をおまけの都合で失う。
 */
suite("用語候補の形を確かめる", () => {
	test("配列でなければ undefined を返すこと（従来どおり）", () => {
		assert.strictEqual(sanitizeTermSuggestions(undefined), undefined);
		assert.strictEqual(sanitizeTermSuggestions("term"), undefined);
		assert.strictEqual(sanitizeTermSuggestions({ source: "a", target: "b" }), undefined);
	});

	test("source の無い候補を落とすこと（実測で落ちた形）", () => {
		const result = sanitizeTermSuggestions([
			{ target: "note", context: "..." },
			{ source: "ノート", target: "note", context: "ノートを開く" },
		]);
		assert.deepStrictEqual(result, [{ source: "ノート", target: "note", context: "ノートを開く" }]);
	});

	test("target が無い・空・文字列でない候補も落とすこと", () => {
		const result = sanitizeTermSuggestions([
			{ source: "ノート" },
			{ source: "ノート", target: "" },
			{ source: "ノート", target: "   " },
			{ source: "ノート", target: 42 },
			{ source: "", target: "note" },
			"ノート",
			null,
			{ source: "タグ", target: "tag", context: "タグを付ける" },
		]);
		assert.deepStrictEqual(result, [{ source: "タグ", target: "tag", context: "タグを付ける" }]);
	});

	test("引用（context）が無いだけで用語を捨てないこと", () => {
		const result = sanitizeTermSuggestions([{ source: "ノート", target: "note" }]);
		assert.deepStrictEqual(result, [{ source: "ノート", target: "note", context: "" }]);
	});

	test("返す候補は source と target と context がすべて文字列であること（受け手の前提）", () => {
		const result = sanitizeTermSuggestions([
			{ source: "ノート", target: "note" },
			{ target: "tag" },
			{ source: "タグ", target: "tag", context: 1 },
		]);
		assert.ok(result);
		for (const candidate of result) {
			assert.strictEqual(typeof candidate.source, "string");
			assert.strictEqual(typeof candidate.target, "string");
			assert.strictEqual(typeof candidate.context, "string");
			// 受け手はこれを呼ぶ。ここで落ちないことが、この番人のすべて
			assert.doesNotThrow(() => candidate.source.toLowerCase());
		}
	});

	test("壊れた候補があっても、翻訳そのものは通すこと", () => {
		const response = JSON.stringify({
			translation: "This is the translated text.",
			termSuggestions: [{ target: "note" }],
		});
		const result = validateTranslationResponse(response);
		assert.strictEqual(result.valid, true, "おまけが壊れていただけで訳文を捨てている");
		assert.strictEqual(result.parsed?.translation, "This is the translated text.");
		assert.deepStrictEqual(result.parsed?.termSuggestions, []);
	});

	test("改訂の応答でも同じであること", () => {
		const response = JSON.stringify({
			targetPatch: "REPLACE 3\nnew line\nEND",
			termSuggestions: [{ source: "ノート", target: "note" }, { target: "tag" }],
		});
		const result = validateRevisionPatchResponse(response);
		assert.strictEqual(result.valid, true);
		assert.deepStrictEqual(result.parsed?.termSuggestions, [
			{ source: "ノート", target: "note", context: "" },
		]);
	});
});
