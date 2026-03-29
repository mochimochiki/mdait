import * as assert from "node:assert";
import { generateContent } from "../../../commands/tm/tm-result-content";

suite("generateContent", () => {
	test("new/update 混在の場合、両セクションに内容が表示される", () => {
		const result = {
			newItems: [{ primary: "Hello.", local: "こんにちは。" }],
			updatedItems: [{ primary: "Goodbye.", local: "さようなら。" }],
		};
		const content = generateContent(result);
		assert.ok(content.includes("## New (1)"));
		assert.ok(content.includes('"Hello."\n  \u2192 "\u3053\u3093\u306b\u3061\u306f\u3002"'));
		assert.ok(content.includes("## Updated (1)"));
		assert.ok(content.includes('"Goodbye."\n  \u2192 "\u3055\u3088\u3046\u306a\u3089\u3002"'));
	});

	test("0件の場合、(none) が両セクションに表示される", () => {
		const result = { newItems: [], updatedItems: [] };
		const content = generateContent(result);
		assert.ok(content.includes("## New (0)"));
		assert.ok(content.includes("## Updated (0)"));
		// (none) が2回出現する（各セクション1回ずつ）
		const noneCount = content.split("(none)").length - 1;
		assert.strictEqual(noneCount, 2);
	});

	test("new 0件・update 1件の場合、New に (none)、Updated に内容が表示される", () => {
		const result = {
			newItems: [],
			updatedItems: [{ primary: "Existing sentence.", local: "既存文" }],
		};
		const content = generateContent(result);
		assert.ok(content.includes("## New (0)"));
		assert.ok(content.includes("(none)"));
		assert.ok(content.includes("## Updated (1)"));
		assert.ok(content.includes('"Existing sentence."\n  \u2192 "\u65e2\u5b58\u6587"'));
	});

	test("特殊文字（& < > など）を含む場合も正しく出力される", () => {
		const result = {
			newItems: [{ primary: "A & B < C > D", local: "特殊文字テスト" }],
			updatedItems: [],
		};
		const content = generateContent(result);
		assert.ok(content.includes('"A & B < C > D"\n  \u2192 "\u7279\u6b8a\u6587\u5b57\u30c6\u30b9\u30c8"'));
	});

	test("ヘッダーにタイムスタンプが含まれる", () => {
		const result = { newItems: [], updatedItems: [] };
		const content = generateContent(result);
		assert.ok(content.startsWith("# TM Commit Results - "));
		// YYYY-MM-DD HH:mm の形式を検証
		assert.match(content, /# TM Commit Results - \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
	});
});
