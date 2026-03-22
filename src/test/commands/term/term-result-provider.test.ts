import * as assert from "node:assert";
import type { TermEntry } from "../../../commands/term/term-entry";
import { generateContent } from "../../../commands/term/term-result-provider";

/** テスト用TermEntryヘルパー */
function entry(
	sourceLang: string,
	sourceTerm: string,
	targetLang: string,
	targetTerm: string | undefined,
	context: string,
): TermEntry {
	const languages: Record<string, { term: string; variants: readonly string[] }> = {
		[sourceLang]: { term: sourceTerm, variants: [] },
	};
	if (targetTerm !== undefined) {
		languages[targetLang] = { term: targetTerm, variants: [] };
	}
	return { context, languages };
}

suite("generateContent (term-detect)", () => {
	const sourceLang = "en";
	const targetLang = "ja";

	test("対訳あり/なし混在の場合、正しく表示される", () => {
		const entries: TermEntry[] = [
			entry(sourceLang, "API endpoint", targetLang, "APIエンドポイント", "An endpoint that accepts HTTP requests"),
			entry(sourceLang, "configuration", targetLang, undefined, "Settings for configuration management"),
		];
		const content = generateContent({ entries, sourceLang, targetLang });

		assert.ok(content.includes("## Detected (2)"));
		assert.ok(content.includes('"API endpoint"\n  \u2192 "API\u30a8\u30f3\u30c9\u30dd\u30a4\u30f3\u30c8"'));
		assert.ok(content.includes('"configuration"\n  (target not detected)'));
		assert.ok(content.includes("context: An endpoint that accepts HTTP requests"));
		assert.ok(content.includes("context: Settings for configuration management"));
	});

	test("0件の場合、(none) が表示される", () => {
		const content = generateContent({ entries: [], sourceLang, targetLang });

		assert.ok(content.includes("## Detected (0)"));
		assert.ok(content.includes("(none)"));
	});

	test("contextが空の場合、context行が省略される", () => {
		const entries: TermEntry[] = [entry(sourceLang, "API", targetLang, "API", "")];
		const content = generateContent({ entries, sourceLang, targetLang });

		assert.ok(content.includes('"API"\n  \u2192 "API"'));
		assert.ok(!content.includes("context:"));
	});

	test("contextありの場合、context行が表示される", () => {
		const entries: TermEntry[] = [entry(sourceLang, "endpoint", targetLang, "エンドポイント", "A network endpoint")];
		const content = generateContent({ entries, sourceLang, targetLang });

		assert.ok(content.includes("  context: A network endpoint"));
	});

	test("特殊文字（& < > など）を含む場合も正しく出力される", () => {
		const entries: TermEntry[] = [
			entry(sourceLang, "A & B < C > D", targetLang, "特殊文字テスト", "context with & < >"),
		];
		const content = generateContent({ entries, sourceLang, targetLang });

		assert.ok(content.includes('"A & B < C > D"\n  \u2192 "\u7279\u6b8a\u6587\u5b57\u30c6\u30b9\u30c8"'));
		assert.ok(content.includes("context: context with & < >"));
	});

	test("ヘッダーにタイムスタンプが含まれる", () => {
		const content = generateContent({ entries: [], sourceLang, targetLang });

		assert.ok(content.startsWith("# Term Detect Results - "));
		assert.match(content, /# Term Detect Results - \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
	});
});
