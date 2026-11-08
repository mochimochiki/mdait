/**
 * @file response-validator-lenient.test.ts
 * @description 文字列の中の書き損じ（エスケープ漏れの `"`・生の改行）を直して読む処理のテスト。
 *
 * 入力の一部は、実 LLM（Haiku 4.5）が日本語→簡体字中国語の翻訳で返した答えそのもの。
 * 「」を ASCII の `"` に置き換えてエスケープせずに返し、厳密な JSON.parse では読めなかった。
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	parseJsonLenient,
	repairJsonStringLiterals,
	validateRevisionPatchResponse,
	validateTranslationResponse,
} from "../../../../commands/trans/response-validator";

/** 実際の答えを読む。コンパイル後は out/ にいるので src/ を指す */
function loadReply(name: string): string {
	const dir = path.resolve(__dirname, "../../../../../src/test/unit/fixtures/ai-replies");
	return fs.readFileSync(path.join(dir, `${name}.txt`), "utf-8");
}

suite("ResponseValidator: 文字列の中の書き損じを直して読む", () => {
	suite("実 LLM の答え（日本語→簡体字中国語）", () => {
		test("訳文の中のエスケープされていない引用符を、訳文の一部として読む", () => {
			const raw = loadReply("haiku-zh-quote-in-translation");
			assert.throws(() => JSON.parse(raw.replace(/^```json\n|\n```$/g, "")));

			const result = validateTranslationResponse(raw);

			assert.strictEqual(result.valid, true, result.error?.message);
			assert.ok(result.parsed?.translation.includes('详细数值和按输入类型分类的精度在"14. 规格"中记载。'));
			assert.ok(result.parsed?.translation.startsWith("## 主要规格概览\n\n"));
			assert.deepStrictEqual(result.parsed?.termSuggestions, []);
		});

		test("termSuggestions の中のエスケープされていない引用符で、訳文を落とさない", () => {
			const raw = loadReply("haiku-zh-quote-in-term-reason");

			const result = validateTranslationResponse(raw);

			assert.strictEqual(result.valid, true, result.error?.message);
			assert.ok(result.parsed?.translation.startsWith("### 电源规格\n\n| 项目 | 规格 |"));
			assert.strictEqual(result.parsed?.termSuggestions?.length, 4);
			assert.deepStrictEqual(result.parsed?.termSuggestions?.[0], {
				source: "外部電源",
				target: "直流电源",
				context: "外部電源 | DC 12〜24 V",
				reason: '根据提供的术语表，此术语应该翻译为"直流电源"',
			});
		});

		test("文字列の中の生の改行を、訳文の改行として読む", () => {
			const raw = loadReply("haiku-zh-raw-newline");

			const result = validateTranslationResponse(raw);

			assert.strictEqual(result.valid, true, result.error?.message);
			const lines = result.parsed?.translation.split("\n") ?? [];
			assert.strictEqual(lines[0], "## 产品特点");
			assert.strictEqual(lines[1], "");
			assert.ok(lines.some((line) => line.includes("「GL Field」")));
		});
	});

	suite("repairJsonStringLiterals", () => {
		test("正しい JSON はそのまま返す", () => {
			const text = '{\n  "translation": "a \\"b\\" c",\n  "termSuggestions": [{"source": "x", "target": "y"}]\n}';
			assert.strictEqual(repairJsonStringLiterals(text), text);
		});

		test("値の中の引用符をエスケープし、キーと値の区切りは残す", () => {
			const text = '{"translation": "见"第3章"。", "warnings": ["注意"A"项"]}';
			assert.deepStrictEqual(JSON.parse(repairJsonStringLiterals(text)), {
				translation: '见"第3章"。',
				warnings: ['注意"A"项'],
			});
		});

		test("引用符で終わる値も、閉じの引用符を取り違えない", () => {
			const text = '{"reason": "应翻译为"采集"",\n "source": "収録"}';
			assert.deepStrictEqual(JSON.parse(repairJsonStringLiterals(text)), {
				reason: '应翻译为"采集"',
				source: "収録",
			});
		});
	});

	suite("parseJsonLenient", () => {
		test("直しても読めない答えは、最初の失敗の理由で落とす", () => {
			const text = '{"translation": "閉じていない';
			let strictMessage = "";
			try {
				JSON.parse(text);
			} catch (e) {
				strictMessage = (e as Error).message;
			}
			assert.throws(() => parseJsonLenient(text), (e: Error) => e.message === strictMessage);
		});

		test("改訂パッチの答えでも、エスケープ漏れの引用符を直して読む", () => {
			const raw = '{"targetPatch": "@@ -1 +1 @@\\n-旧\\n+见"第3章"", "termSuggestions": []}';
			const result = validateRevisionPatchResponse(raw);
			assert.strictEqual(result.valid, true, result.error?.message);
			assert.strictEqual(result.parsed?.targetPatch, '@@ -1 +1 @@\n-旧\n+见"第3章"');
		});
	});
});
