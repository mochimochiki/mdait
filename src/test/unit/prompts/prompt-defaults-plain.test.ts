/**
 * @file prompt-defaults-plain.test.ts
 * @description 非MDファイル用プロンプトテンプレートの登録確認テスト
 */

import { strict as assert } from "node:assert";
import { DEFAULT_PROMPTS, PromptIds } from "../../../prompts/defaults";

suite("非MDファイル用デフォルトプロンプト", () => {
	test("TRANS_TRANSLATE_PLAINがDEFAULT_PROMPTSに登録されている", () => {
		const prompt = DEFAULT_PROMPTS[PromptIds.TRANS_TRANSLATE_PLAIN];
		assert.ok(prompt, "TRANS_TRANSLATE_PLAINがDEFAULT_PROMPTSに存在すること");
		assert.ok(prompt.length > 0, "プロンプトが空でないこと");
	});

	test("TRANS_REVISE_PATCH_PLAINがDEFAULT_PROMPTSに登録されている", () => {
		const prompt = DEFAULT_PROMPTS[PromptIds.TRANS_REVISE_PATCH_PLAIN];
		assert.ok(prompt, "TRANS_REVISE_PATCH_PLAINがDEFAULT_PROMPTSに存在すること");
		assert.ok(prompt.length > 0, "プロンプトが空でないこと");
	});

	test("TRANS_TRANSLATE_PLAINに必要な変数プレースホルダーが含まれる", () => {
		const prompt = DEFAULT_PROMPTS[PromptIds.TRANS_TRANSLATE_PLAIN];
		assert.ok(prompt.includes("{{sourceLang}}"), "sourceLang変数が含まれること");
		assert.ok(prompt.includes("{{targetLang}}"), "targetLang変数が含まれること");
		assert.ok(prompt.includes("{{fileExtension}}"), "fileExtension変数が含まれること");
		assert.ok(prompt.includes("{{terms}}"), "terms変数が含まれること");
		assert.ok(prompt.includes("{{tmReferences}}"), "tmReferences変数が含まれること");
	});

	test("TRANS_REVISE_PATCH_PLAINに必要な変数プレースホルダーが含まれる", () => {
		const prompt = DEFAULT_PROMPTS[PromptIds.TRANS_REVISE_PATCH_PLAIN];
		assert.ok(prompt.includes("{{sourceDiff}}"), "sourceDiff変数が含まれること");
		assert.ok(
			prompt.includes("{{numberedPreviousTranslation}}"),
			"行番号付きの前回訳文の変数が含まれること（ADR-260903-01）",
		);
		assert.ok(prompt.includes("{{fileExtension}}"), "fileExtension変数が含まれること");
	});

	test("非MDプロンプトにMarkdown固有ルールが含まれない", () => {
		const translatePlain = DEFAULT_PROMPTS[PromptIds.TRANS_TRANSLATE_PLAIN];
		const revisePlain = DEFAULT_PROMPTS[PromptIds.TRANS_REVISE_PATCH_PLAIN];

		assert.ok(!translatePlain.includes("Markdown Preservation Rules"), "Markdown保持ルールが含まれないこと");
		assert.ok(!revisePlain.includes("Markdown structure"), "Markdown構造への言及がないこと");
	});

	test("初回翻訳は JSON、改訂は素のテキストを求める", () => {
		const translatePlain = DEFAULT_PROMPTS[PromptIds.TRANS_TRANSLATE_PLAIN];
		const revisePlain = DEFAULT_PROMPTS[PromptIds.TRANS_REVISE_PATCH_PLAIN];

		assert.ok(translatePlain.includes('"translation"'), "translate用プロンプトにtranslationフィールドが含まれること");
		// 改訂は JSON の封筒をやめた（ADR-260903-01）。封筒はフェンス包みと
		// エスケープ負荷を招き、後者は逐語コピーを実際に壊していた
		assert.ok(!revisePlain.includes('"targetPatch"'), "改訂用プロンプトが JSON を求めていないこと");
		assert.ok(revisePlain.includes("REPLACE"), "改訂用プロンプトが行番号方式を指示していること");
	});
});
