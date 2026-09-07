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
import { UnusableAIResponseError } from "../../../../infra/llm/unusable-response";

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

/**
 * 使えない答えを 0 件として飲み込まないことのテスト。
 *
 * 実測で見つかった欠陥の回帰固定: パースに失敗すると空の対応表を返していたため、
 * 「埋められる用語が無かった」と「AI の答えが使えなかった」が同じ顔で終わっていた。
 */
suite("AITermExpander - 使えない答えは0件にしない", () => {
	/** 決まった文字列を返す AIService */
	class FixedAIService implements AIService {
		constructor(private readonly response: string) {}
		async sendMessage(): Promise<string> {
			return this.response;
		}
	}

	const rejects = async (response: string, why: string) => {
		const expander = new AITermExpander(new FixedAIService(response));
		await assert.rejects(
			expander.extractFromTranslationsBatch([createContext()], "en", "ja"),
			(error: unknown) => error instanceof UnusableAIResponseError && error.reason === "invalid-format",
			why,
		);
	};

	test("オブジェクトがどこにも無い答えは断ち切る", async () => {
		await rejects("no json here", "対応表が無ければ断ち切ること");
	});

	test("空の答えは「使えない」ではなく「空」として伝える", async () => {
		const expander = new AITermExpander(new FixedAIService("   "));
		await assert.rejects(
			expander.extractFromTranslationsBatch([createContext()], "en", "ja"),
			(error: unknown) => error instanceof UnusableAIResponseError && error.reason === "empty",
			"理由が empty であること（利用者への案内文が変わる）",
		);
	});

	test("コードフェンスに包まれた答えは読める（前置き・後書きがあっても）", async () => {
		const response = ['訳語を拾いました。', "```json", '{"API endpoint": "APIエンドポイント"}', "```", "以上。"].join(
			"\n",
		);
		const expander = new AITermExpander(new FixedAIService(response));

		const result = await expander.extractFromTranslationsBatch([createContext()], "en", "ja");

		assert.strictEqual(result.get("API endpoint"), "APIエンドポイント");
	});

	test("途中で切れた JSON は断ち切る", async () => {
		await rejects('{"API endpoint": "APIエンド', "閉じていない JSON を断ち切ること");
	});

	test("値が1つも文字列でない答えは断ち切る", async () => {
		await rejects('{"API endpoint": null, "Payload": 12}', "拾えるものが無ければ断ち切ること");
	});

	test("空のオブジェクトは「埋められる用語なし」として受け入れる", async () => {
		const expander = new AITermExpander(new FixedAIService("{}"));
		const result = await expander.extractFromTranslationsBatch([createContext()], "en", "ja");
		assert.strictEqual(result.size, 0);
	});
});
