import * as assert from "node:assert";
import { type TermLintTerm, lintUnitPair } from "../../../../core/term/term-lint";
import {
	anyTermVariantAppears,
	stripCodeSegments,
	textContainsTerm,
} from "../../../../core/term/term-matcher";

function term(overrides: Partial<TermLintTerm> = {}): TermLintTerm {
	return {
		source: "翻訳メモリ",
		sourceVariants: [],
		expected: "translation memory",
		expectedVariants: [],
		...overrides,
	};
}

suite("term-matcher（用語照合の純関数）", () => {
	test("部分一致で用語を検出する（活用形も拾う）", () => {
		assert.strictEqual(textContainsTerm("The unit was translated.", "translate"), true);
		assert.strictEqual(textContainsTerm("No match here.", "translate"), false);
	});

	test("空の用語はマッチしない", () => {
		assert.strictEqual(textContainsTerm("anything", ""), false);
	});

	test("variantsのいずれかが出現すればtrue", () => {
		assert.strictEqual(anyTermVariantAppears("uses trans memory", "translation memory", ["trans memory"]), true);
		assert.strictEqual(anyTermVariantAppears("nothing", "translation memory", ["trans memory"]), false);
	});

	suite("stripCodeSegments", () => {
		test("フェンス付きコードブロックの行が除去される", () => {
			const content = "本文に翻訳メモリがある\n```\ncode 翻訳メモリ code\n```\n後続テキスト";
			const stripped = stripCodeSegments(content);
			assert.ok(stripped.includes("本文に翻訳メモリがある"));
			assert.ok(!stripped.includes("code 翻訳メモリ code"));
			assert.ok(stripped.includes("後続テキスト"));
		});

		test("インラインコードが除去される", () => {
			const stripped = stripCodeSegments("この `翻訳メモリ` はコードです");
			assert.ok(!stripped.includes("翻訳メモリ"));
			assert.ok(stripped.includes("はコードです"));
		});
	});
});

suite("term-lint（用語一貫性検証）", () => {
	test("原文に用語が出現し訳文に期待訳語がない → 違反", () => {
		const violations = lintUnitPair(
			"## 概要\n\n翻訳メモリを使います。",
			"## Overview\n\nWe use the TM database.",
			[term()],
		);
		assert.strictEqual(violations.length, 1);
		assert.strictEqual(violations[0].term, "翻訳メモリ");
		assert.strictEqual(violations[0].expected, "translation memory");
	});

	test("訳文に期待訳語がある → 違反なし", () => {
		const violations = lintUnitPair(
			"翻訳メモリを使います。",
			"We use the translation memory.",
			[term()],
		);
		assert.strictEqual(violations.length, 0);
	});

	test("訳文にvariantsが出現する → 違反なし（揺れの正当化）", () => {
		const violations = lintUnitPair("翻訳メモリを使います。", "We use the TM.", [
			term({ expectedVariants: ["TM"] }),
		]);
		assert.strictEqual(violations.length, 0);
	});

	test("原文に用語が出現しない → 違反なし（保守的閾値）", () => {
		const violations = lintUnitPair("用語のない本文。", "Text without terms.", [term()]);
		assert.strictEqual(violations.length, 0);
	});

	test("原文のvariantsで出現しても検証対象になる", () => {
		const violations = lintUnitPair("TMメモリを使います。", "We use something else.", [
			term({ sourceVariants: ["TMメモリ"] }),
		]);
		assert.strictEqual(violations.length, 1);
	});

	test("偽陽性防止: コードブロック内の用語出現は照合対象外", () => {
		const violations = lintUnitPair(
			"```\n翻訳メモリ\n```\nコード以外に用語なし。",
			"No terms in prose.",
			[term()],
		);
		assert.strictEqual(violations.length, 0);
	});

	test("偽陽性防止: インラインコード内の用語出現は照合対象外", () => {
		const violations = lintUnitPair(
			"`翻訳メモリ` という識別子。",
			"The identifier `translation memory`.",
			[term()],
		);
		assert.strictEqual(violations.length, 0);
	});

	test("訳文側のコードブロック内の期待訳語はカウントされない（本文に必要）", () => {
		const violations = lintUnitPair(
			"翻訳メモリを使います。",
			"```\ntranslation memory\n```\nProse without the term.",
			[term()],
		);
		assert.strictEqual(violations.length, 1);
	});

	test("複数用語の違反が個別にレポートされる", () => {
		const violations = lintUnitPair(
			"翻訳メモリと用語集を使います。",
			"We use nothing relevant.",
			[term(), term({ source: "用語集", expected: "glossary" })],
		);
		assert.strictEqual(violations.length, 2);
	});

	test("用語リストが空なら違反なし", () => {
		assert.deepStrictEqual(lintUnitPair("翻訳メモリ", "anything", []), []);
	});
});
