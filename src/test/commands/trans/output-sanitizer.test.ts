/**
 * @file output-sanitizer.test.ts
 * @description OutputSanitizerのテスト実装
 * 翻訳出力内のJSON残存検出ロジックの検証
 */

import { strict as assert } from "node:assert";
import { sanitizeTranslationOutput } from "../../../commands/trans/output-sanitizer";

suite("OutputSanitizer", () => {
	suite("sanitizeTranslationOutput", () => {
		test("通常のテキストは警告なしで通過する", () => {
			const text = "これは通常の翻訳されたテキストです。\n\n## 見出し\n\nコンテンツ...";
			const result = sanitizeTranslationOutput(text);

			assert.strictEqual(result.jsonDetected, false);
			assert.strictEqual(result.warnings.length, 0);
			assert.strictEqual(result.detectedPatterns.length, 0);
			assert.strictEqual(result.text, text);
		});

		test("マークダウン形式のテキストは警告なしで通過する", () => {
			const text = `# タイトル

## セクション1

これはテストです。

- リスト1
- リスト2

> 引用文

**太字** と *斜体*`;
			const result = sanitizeTranslationOutput(text);

			assert.strictEqual(result.jsonDetected, false);
			assert.strictEqual(result.warnings.length, 0);
		});

		test("TRANSLATION_WRAPPER パターンを検出する", () => {
			const text = '{"translation": "翻訳されたテキスト"}';
			const result = sanitizeTranslationOutput(text);

			assert.strictEqual(result.jsonDetected, true);
			assert.ok(result.warnings.length > 0);
			assert.ok(result.detectedPatterns.some((p) => p.type === "TRANSLATION_WRAPPER"));
		});

		test("targetPatch ラッパーパターンを検出する", () => {
			const text = '{"targetPatch": "--- content\\n+++ content"}';
			const result = sanitizeTranslationOutput(text);

			assert.strictEqual(result.jsonDetected, true);
			assert.ok(result.detectedPatterns.some((p) => p.type === "TRANSLATION_WRAPPER"));
		});

		test("FULL_JSON_OBJECT パターンを検出する", () => {
			const text = '{"key": "value", "number": 123}';
			const result = sanitizeTranslationOutput(text);

			assert.strictEqual(result.jsonDetected, true);
			// TRANSLATION_WRAPPER または FULL_JSON_OBJECT のいずれかがマッチ
			assert.ok(result.detectedPatterns.length > 0);
		});

		test("ESCAPED_JSON パターンを検出する", () => {
			const text = 'テキスト \\"key\\": \\"value\\" テキスト';
			const result = sanitizeTranslationOutput(text);

			assert.strictEqual(result.jsonDetected, true);
			assert.ok(result.detectedPatterns.some((p) => p.type === "ESCAPED_JSON"));
		});

		test("NESTED_BRACES パターンを検出する", () => {
			const text = "何か {{{ 深くネストされた }}} テキスト";
			const result = sanitizeTranslationOutput(text);

			assert.strictEqual(result.jsonDetected, true);
			assert.ok(result.detectedPatterns.some((p) => p.type === "NESTED_BRACES"));
		});

		test("コードブロック内のJSONは除外される", () => {
			const text = `通常のテキスト

\`\`\`json
{"key": "value", "translation": "テスト"}
\`\`\`

コードブロック外のテキスト`;
			const result = sanitizeTranslationOutput(text);

			assert.strictEqual(result.jsonDetected, false);
			assert.strictEqual(result.warnings.length, 0);
		});

		test("コードブロック外のJSONは検出される", () => {
			const text = `\`\`\`json
{"key": "value"}
\`\`\`

コードブロック外の {"translation": "問題のあるJSON"}`;
			const result = sanitizeTranslationOutput(text);

			assert.strictEqual(result.jsonDetected, true);
			assert.ok(result.warnings.length > 0);
		});

		test("複数のパターンが検出される", () => {
			const text = `{"translation": "ラッパー"}

\\"escaped\\": \\"json\\"`;
			const result = sanitizeTranslationOutput(text);

			assert.strictEqual(result.jsonDetected, true);
			assert.ok(result.detectedPatterns.length >= 2);
		});

		test("検出されたパターンの位置情報が正しい", () => {
			const text = 'prefix {"translation": "テスト"}';
			const result = sanitizeTranslationOutput(text);

			assert.strictEqual(result.jsonDetected, true);
			assert.ok(result.detectedPatterns.length > 0);
			const pattern = result.detectedPatterns[0];
			assert.ok(pattern.position > 0); // "prefix "の後
		});

		test("サンプルは50文字以内に切り詰められる", () => {
			const longValue = "a".repeat(100);
			const text = `{"translation": "${longValue}"}`;
			const result = sanitizeTranslationOutput(text);

			assert.strictEqual(result.jsonDetected, true);
			assert.ok(result.detectedPatterns.length > 0);
			assert.ok(result.detectedPatterns[0].sample.length <= 50);
		});

		test("テキストは変更されない（警告のみ）", () => {
			const text = '{"translation": "問題のあるテキスト"}';
			const result = sanitizeTranslationOutput(text);

			assert.strictEqual(result.text, text);
		});

		test("波括弧を含む通常のテキストは誤検出しない", () => {
			const text = "関数 f(x) = { x + 1 } は定義域全体で連続です。";
			const result = sanitizeTranslationOutput(text);

			assert.strictEqual(result.jsonDetected, false);
		});

		test("Mustacheテンプレート構文は誤検出しない", () => {
			const text = "{{#items}}{{name}}{{/items}}";
			const result = sanitizeTranslationOutput(text);

			// NESTED_BRACESパターンは {{{ を検出するので、{{# は検出されない
			assert.strictEqual(result.jsonDetected, false);
		});

		test("空文字列を処理できる", () => {
			const result = sanitizeTranslationOutput("");

			assert.strictEqual(result.jsonDetected, false);
			assert.strictEqual(result.text, "");
			assert.strictEqual(result.warnings.length, 0);
		});
	});
});
