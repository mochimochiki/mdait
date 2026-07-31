/**
 * @file term-expander.test.ts
 * @description AITermExpander のエラー伝播のテスト
 * AI呼び出しの失敗を「0件展開の成功」と誤認させないことを検証する。
 */

import { strict as assert } from "node:assert";
import { LangTerm, TermEntry } from "../../../../commands/term/term-entry";
import { AITermExpander, type TermExpansionContext } from "../../../../commands/term/term-expander";
import { MdaitMarker } from "../../../../core/markdown/mdait-marker";
import { MdaitUnit } from "../../../../core/markdown/mdait-unit";
import type { AIService } from "../../../../infra/llm/ai-service";

/** 常に失敗する AIService（AI未接続などを模擬） */
class FailingAIService implements AIService {
	async sendMessage(): Promise<string> {
		throw new Error("Language model is not available. Please ensure GitHub Copilot is enabled.");
	}
}

function createContext(): TermExpansionContext {
	const sourceUnit = new MdaitUnit(new MdaitMarker("abc123"), "Section", 1, "# Section\n\nAPI endpoint content", 0, 2);
	const targetUnit = new MdaitUnit(
		new MdaitMarker("def456", "abc123"),
		"Section",
		1,
		"# Section\n\nAPIエンドポイントの内容",
		0,
		2,
	);
	const term = TermEntry.create("API endpoint context", {
		en: LangTerm.create("API endpoint"),
	});
	return { sourceUnit, targetUnit, terms: [term] };
}

suite("AITermExpander - AIエラーの伝播", () => {
	test("対訳抽出でAI呼び出しが失敗した場合は握りつぶさず例外を投げる", async () => {
		const expander = new AITermExpander(new FailingAIService());

		await assert.rejects(
			expander.extractFromTranslationsBatch([createContext()], "en", "ja"),
			/Language model is not available/,
		);
	});

	test("用語AI翻訳でAI呼び出しが失敗した場合は握りつぶさず例外を投げる", async () => {
		const expander = new AITermExpander(new FailingAIService());
		const term = TermEntry.create("API endpoint context", {
			en: LangTerm.create("API endpoint"),
		});

		await assert.rejects(expander.translateTerms([term], "en", "ja"), /Language model is not available/);
	});
});
