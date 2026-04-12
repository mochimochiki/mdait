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
		assert.ok(
			prompt,
			"TRANS_REVISE_PATCH_PLAINがDEFAULT_PROMPTSに存在すること",
		);
		assert.ok(prompt.length > 0, "プロンプトが空でないこと");
	});

	test("TRANS_TRANSLATE_PLAINに必要な変数プレースホルダーが含まれる", () => {
		const prompt = DEFAULT_PROMPTS[PromptIds.TRANS_TRANSLATE_PLAIN];
		assert.ok(
			prompt.includes("{{sourceLang}}"),
			"sourceLang変数が含まれること",
		);
		assert.ok(
			prompt.includes("{{targetLang}}"),
			"targetLang変数が含まれること",
		);
		assert.ok(
			prompt.includes("{{fileExtension}}"),
			"fileExtension変数が含まれること",
		);
		assert.ok(prompt.includes("{{terms}}"), "terms変数が含まれること");
		assert.ok(
			prompt.includes("{{tmReferences}}"),
			"tmReferences変数が含まれること",
		);
	});

	test("TRANS_REVISE_PATCH_PLAINに必要な変数プレースホルダーが含まれる", () => {
		const prompt = DEFAULT_PROMPTS[PromptIds.TRANS_REVISE_PATCH_PLAIN];
		assert.ok(
			prompt.includes("{{sourceDiff}}"),
			"sourceDiff変数が含まれること",
		);
		assert.ok(
			prompt.includes("{{previousTranslation}}"),
			"previousTranslation変数が含まれること",
		);
		assert.ok(
			prompt.includes("{{fileExtension}}"),
			"fileExtension変数が含まれること",
		);
	});

	test("非MDプロンプトにMarkdown固有ルールが含まれない", () => {
		const translatePlain = DEFAULT_PROMPTS[PromptIds.TRANS_TRANSLATE_PLAIN];
		const revisePlain = DEFAULT_PROMPTS[PromptIds.TRANS_REVISE_PATCH_PLAIN];

		assert.ok(
			!translatePlain.includes("Markdown Preservation Rules"),
			"Markdown保持ルールが含まれないこと",
		);
		assert.ok(
			!revisePlain.includes("Markdown structure"),
			"Markdown構造への言及がないこと",
		);
	});

	test("非MDプロンプトにJSON出力フォーマットが含まれる", () => {
		const translatePlain = DEFAULT_PROMPTS[PromptIds.TRANS_TRANSLATE_PLAIN];
		const revisePlain = DEFAULT_PROMPTS[PromptIds.TRANS_REVISE_PATCH_PLAIN];

		assert.ok(
			translatePlain.includes('"translation"'),
			"translate用プロンプトにtranslationフィールドが含まれること",
		);
		assert.ok(
			revisePlain.includes('"targetPatch"'),
			"revise用プロンプトにtargetPatchフィールドが含まれること",
		);
	});
});
