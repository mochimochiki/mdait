/**
 * @file prompt-provider-parts.test.ts
 * @description プロンプトの system / user-section 分割（getPromptParts）のテスト
 * プレフィックスキャッシュの前提となる「system部の安定性」を回帰防止する
 */

import { strict as assert } from "node:assert";
import {
	DEFAULT_PROMPTS,
	PromptIds,
	SOURCE_TEXT_SEPARATOR,
	USER_SECTION_MARKER,
} from "../../../prompts/defaults";
import {
	PromptProvider,
	buildUserMessage,
} from "../../../prompts/prompt-provider";
import { Configuration } from "../../../infra/config/configuration";

/** 翻訳系4テンプレート（system/user-section分割の対象） */
const TRANS_PROMPT_IDS = [
	PromptIds.TRANS_TRANSLATE,
	PromptIds.TRANS_REVISE_PATCH,
	PromptIds.TRANS_TRANSLATE_PLAIN,
	PromptIds.TRANS_REVISE_PATCH_PLAIN,
] as const;

suite("プロンプトのsystem/user-section分割", () => {
	setup(() => {
		Configuration.dispose();
		PromptProvider.dispose();
	});

	teardown(() => {
		Configuration.dispose();
		PromptProvider.dispose();
	});

	test("翻訳系4テンプレートすべてにuser-sectionマーカーが含まれる", () => {
		for (const promptId of TRANS_PROMPT_IDS) {
			assert.ok(
				DEFAULT_PROMPTS[promptId].includes(USER_SECTION_MARKER),
				`${promptId} にマーカーが含まれること`,
			);
		}
	});

	test("可変データはuserContext側に入りsystem側には含まれない", () => {
		const provider = PromptProvider.getInstance();
		const parts = provider.getPromptParts(PromptIds.TRANS_TRANSLATE, {
			sourceLang: "ja",
			targetLang: "en",
			contextLang: "en",
			terms: '[{"term":"用語ABC","translation":"term ABC"}]',
			tmReferences: "TM-REFERENCE-XYZ",
			surroundingText: "SURROUNDING-TEXT-123",
		});

		assert.strictEqual(parts.isLegacy, false);
		assert.ok(parts.userContext.includes("用語ABC"));
		assert.ok(parts.userContext.includes("TM-REFERENCE-XYZ"));
		assert.ok(parts.userContext.includes("SURROUNDING-TEXT-123"));
		assert.ok(!parts.system.includes("用語ABC"));
		assert.ok(!parts.system.includes("TM-REFERENCE-XYZ"));
		assert.ok(!parts.system.includes("SURROUNDING-TEXT-123"));
	});

	test("可変データ・言語ペア・拡張子が異なってもsystem部が完全一致する", () => {
		const provider = PromptProvider.getInstance();
		for (const promptId of TRANS_PROMPT_IDS) {
			const parts1 = provider.getPromptParts(promptId, {
				sourceLang: "ja",
				targetLang: "en",
				contextLang: "en",
				fileExtension: ".csv",
				terms: '[{"term":"A"}]',
				tmReferences: "ref-1",
				previousTranslation: "old translation 1",
				sourceDiff: "-a\n+b",
			});
			const parts2 = provider.getPromptParts(promptId, {
				sourceLang: "de",
				targetLang: "fr",
				contextLang: "de",
				fileExtension: ".txt",
				surroundingText: "totally different context",
				previousTranslation: "old translation 2",
				sourceDiff: "-x\n+y",
			});
			assert.strictEqual(
				parts1.system,
				parts2.system,
				`${promptId} のsystem部が可変データ・言語ペアに依存しないこと`,
			);
		}
	});

	test("テンプレートのsystem部に変数プレースホルダーが含まれない", () => {
		// system部が完全静的であること（プロンプト種別ごとに全ワークスペース共通の
		// 単一キャッシュエントリになる）をテンプレートレベルで保証する
		for (const promptId of TRANS_PROMPT_IDS) {
			const systemTemplate =
				DEFAULT_PROMPTS[promptId].split(USER_SECTION_MARKER)[0];
			assert.ok(
				!systemTemplate.includes("{{"),
				`${promptId} のsystem部に {{...}} が残っていないこと`,
			);
		}
	});

	test("言語指定はuserContextのTranslation Directionに入る", () => {
		const provider = PromptProvider.getInstance();
		const parts = provider.getPromptParts(PromptIds.TRANS_TRANSLATE, {
			sourceLang: "ja",
			targetLang: "en",
			contextLang: "en",
		});
		assert.ok(parts.userContext.includes("Translation Direction:"));
		assert.ok(parts.userContext.includes("Source language: ja"));
		assert.ok(parts.userContext.includes("Target language: en"));
	});

	test("system部とuserContextにマーカー文字列が残らない", () => {
		const provider = PromptProvider.getInstance();
		for (const promptId of TRANS_PROMPT_IDS) {
			const parts = provider.getPromptParts(promptId, {
				sourceLang: "ja",
				targetLang: "en",
				terms: "[]",
				previousTranslation: "prev",
				sourceDiff: "-a\n+b",
			});
			assert.ok(!parts.system.includes(USER_SECTION_MARKER));
			assert.ok(!parts.userContext.includes(USER_SECTION_MARKER));
		}
	});

	test("マーカーのないテンプレートはレガシーとして従来通り全体をsystemに格納する", () => {
		const provider = PromptProvider.getInstance();
		// term系テンプレートにはマーカーがない
		const parts = provider.getPromptParts(PromptIds.TERM_DETECT_PAIRS, {
			sourceLang: "ja",
			targetLang: "en",
			contextLang: "en",
			pairs: "PAIR-DATA",
		});

		assert.strictEqual(parts.isLegacy, true);
		assert.strictEqual(parts.userContext, "");
		assert.ok(parts.system.includes("PAIR-DATA"));
		// getPrompt と同一結果になること（後方互換）
		const combined = provider.getPrompt(PromptIds.TERM_DETECT_PAIRS, {
			sourceLang: "ja",
			targetLang: "en",
			contextLang: "en",
			pairs: "PAIR-DATA",
		});
		assert.strictEqual(parts.system, combined);
	});

	test("getPromptはマーカー付きテンプレートでもsystemとuserContextを結合して返す", () => {
		const provider = PromptProvider.getInstance();
		const variables = {
			sourceLang: "ja",
			targetLang: "en",
			contextLang: "en",
			terms: "TERMS-JSON",
		};
		const combined = provider.getPrompt(PromptIds.TRANS_TRANSLATE, variables);
		const parts = provider.getPromptParts(PromptIds.TRANS_TRANSLATE, variables);

		assert.ok(!combined.includes(USER_SECTION_MARKER));
		assert.ok(combined.includes("TERMS-JSON"));
		assert.strictEqual(combined, `${parts.system}\n\n${parts.userContext}`);
	});

	test("system部に翻訳指示と出力フォーマット仕様が含まれる", () => {
		const provider = PromptProvider.getInstance();
		const parts = provider.getPromptParts(PromptIds.TRANS_TRANSLATE, {
			sourceLang: "ja",
			targetLang: "en",
		});
		assert.ok(parts.system.includes("Markdown Preservation Rules"));
		assert.ok(parts.system.includes('"translation"'));
		assert.ok(parts.system.includes(SOURCE_TEXT_SEPARATOR));
	});
});

suite("buildUserMessage", () => {
	test("コンテキストありの場合は区切り行を挟んで本文を連結する", () => {
		const message = buildUserMessage(
			{ system: "sys", userContext: "CONTEXT", isLegacy: false },
			"BODY",
		);
		assert.strictEqual(message, `CONTEXT\n\n${SOURCE_TEXT_SEPARATOR}\nBODY`);
	});

	test("コンテキストが空でも区切り行は付与される", () => {
		const message = buildUserMessage(
			{ system: "sys", userContext: "", isLegacy: false },
			"BODY",
		);
		assert.strictEqual(message, `${SOURCE_TEXT_SEPARATOR}\nBODY`);
	});

	test("レガシーテンプレートの場合は本文のみを返す（従来挙動）", () => {
		const message = buildUserMessage(
			{ system: "sys", userContext: "", isLegacy: true },
			"BODY",
		);
		assert.strictEqual(message, "BODY");
	});
});
