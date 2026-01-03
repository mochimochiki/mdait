/**
 * @file term-expander.ts
 * @description 用語展開サービス
 * 検出済み用語を対象言語に展開する（既存対訳優先、AI翻訳フォールバック）
 */

import type * as vscode from "vscode";
import type { AIService } from "../../api/ai-service";
import { AIServiceBuilder } from "../../api/ai-service-builder";
import type { MdaitUnit } from "../../core/markdown/mdait-unit";
import { PromptIds, PromptProvider } from "../../prompts";
import type { TermEntry } from "./term-entry";
import { TermEntry as TermEntryUtils } from "./term-entry";

/**
 * 用語展開コンテキスト
 */
export interface TermExpansionContext {
	sourceUnit: MdaitUnit;
	targetUnit: MdaitUnit;
	terms: readonly TermEntry[];
}

/**
 * 用語展開サービスのインターフェース
 */
export interface TermExpander {
	/**
	 * Phase 2: 既存対訳ファイルから用語ペアをバッチ抽出
	 *
	 * @param contexts 用語展開コンテキストの配列
	 * @param sourceLang ソース言語コード
	 * @param targetLang ターゲット言語コード
	 * @param cancellationToken キャンセル処理用トークン
	 * @returns 用語の対応マップ（sourceTerm -> targetTerm）
	 */
	extractFromTranslationsBatch(
		contexts: readonly TermExpansionContext[],
		sourceLang: string,
		targetLang: string,
		cancellationToken?: vscode.CancellationToken,
	): Promise<Map<string, string>>;

	/**
	 * Phase 3: 未解決用語をAI翻訳
	 *
	 * @param terms 展開対象の用語エントリ（ソース言語のみ存在）
	 * @param sourceLang ソース言語コード
	 * @param targetLang ターゲット言語コード
	 * @param cancellationToken キャンセル処理用トークン
	 * @returns 用語の対応マップ（sourceTerm -> targetTerm）
	 */
	translateTerms(
		terms: readonly TermEntry[],
		sourceLang: string,
		targetLang: string,
		cancellationToken?: vscode.CancellationToken,
	): Promise<Map<string, string>>;
}

/**
 * AIサービスを使用する用語展開実装
 */
export class AITermExpander implements TermExpander {
	private readonly aiService: AIService;

	constructor(aiService: AIService) {
		this.aiService = aiService;
	}

	/**
	 * Phase 2: 既存対訳から用語ペアをバッチ抽出
	 */
	async extractFromTranslationsBatch(
		contexts: readonly TermExpansionContext[],
		sourceLang: string,
		targetLang: string,
		cancellationToken?: vscode.CancellationToken,
	): Promise<Map<string, string>> {
		if (cancellationToken?.isCancellationRequested) {
			return new Map();
		}

		if (contexts.length === 0) {
			return new Map();
		}

		const translationPairs = contexts.map((ctx) => ({
			source: ctx.sourceUnit.content,
			target: ctx.targetUnit.content,
		}));

		const allTerms = new Set<string>();
		for (const ctx of contexts) {
			for (const term of ctx.terms) {
				const termText = term.languages[sourceLang]?.term;
				if (termText) {
					allTerms.add(termText);
				}
			}
		}

		const termList = Array.from(allTerms);

		if (termList.length === 0) {
			return new Map();
		}

		const promptProvider = PromptProvider.getInstance();
		const systemPrompt = promptProvider.getPrompt(PromptIds.TERM_EXTRACT_FROM_TRANSLATIONS, {
			sourceLang,
			targetLang,
		});

		const userPrompt = this.buildExtractionPrompt(translationPairs, termList, sourceLang, targetLang);

		try {
			const stream = this.aiService.sendMessage(systemPrompt, [{ role: "user", content: userPrompt }]);
			let response = "";
			for await (const chunk of stream) {
				response += chunk;
			}

			return this.parseExtractionResponse(response);
		} catch (error) {
			console.error("Phase 2 batch extraction failed:", error);
			return new Map();
		}
	}

	/**
	 * Phase 3: AI翻訳で用語を展開
	 */
	async translateTerms(
		terms: readonly TermEntry[],
		sourceLang: string,
		targetLang: string,
		cancellationToken?: vscode.CancellationToken,
	): Promise<Map<string, string>> {
		if (cancellationToken?.isCancellationRequested) {
			return new Map();
		}

		// 翻訳対象の用語を抽出
		const termsToTranslate = terms.filter((entry) => entry.languages[sourceLang]);

		if (termsToTranslate.length === 0) {
			return new Map();
		}

		// AIプロンプトを取得
		const promptProvider = PromptProvider.getInstance();
		const systemPrompt = promptProvider.getPrompt(PromptIds.TERM_TRANSLATE_TERMS, {
			sourceLang,
			targetLang,
		});

		const userPrompt = this.buildTranslationPrompt(termsToTranslate, sourceLang, targetLang);

		try {
			const stream = this.aiService.sendMessage(systemPrompt, [{ role: "user", content: userPrompt }]);
			let response = "";
			for await (const chunk of stream) {
				response += chunk;
			}

			return this.parseTranslationResponse(response);
		} catch (error) {
			console.error("Phase 2 translation failed:", error);
			return new Map();
		}
	}

	/**
	 * Phase 1用のプロンプトを構築
	 */
	private buildExtractionPrompt(
		pairs: Array<{ source: string; target: string }>,
		termList: string[],
		sourceLang: string,
		targetLang: string,
	): string {
		const pairTexts = pairs
			.slice(0, 10) // 最大10ペアに制限
			.map(
				(p, i) => `
### Pair ${i + 1}
**Source (${sourceLang}):**
${p.source}

**Target (${targetLang}):**
${p.target}
`,
			)
			.join("\n");

		return `Extract the ${targetLang} translations for these ${sourceLang} terms:
${termList.map((t) => `- ${t}`).join("\n")}

From these translation pairs:
${pairTexts}

Return the result as a JSON object.`;
	}

	/**
	 * Phase 2用のプロンプトを構築
	 */
	private buildTranslationPrompt(terms: readonly TermEntry[], sourceLang: string, targetLang: string): string {
		const termTexts = terms
			.map((entry) => {
				const term = entry.languages[sourceLang].term;
				const context = entry.context;
				return `- **${term}** (context: ${context})`;
			})
			.join("\n");

		return `Translate these ${sourceLang} terms to ${targetLang}:

${termTexts}

Return the result as a JSON object mapping source terms to target terms.`;
	}

	/**
	 * Phase 1のAIレスポンスをパース
	 */
	private parseExtractionResponse(response: string): Map<string, string> {
		try {
			// JSONブロックを抽出
			const jsonMatch = response.match(/\{[\s\S]*\}/);
			if (!jsonMatch) {
				return new Map();
			}

			const parsed = JSON.parse(jsonMatch[0]);
			return new Map(Object.entries(parsed) as Array<[string, string]>);
		} catch (error) {
			console.error("Failed to parse extraction response:", error);
			return new Map();
		}
	}

	/**
	 * Phase 2のAIレスポンスをパース
	 */
	private parseTranslationResponse(response: string): Map<string, string> {
		try {
			// JSONブロックを抽出
			const jsonMatch = response.match(/\{[\s\S]*\}/);
			if (!jsonMatch) {
				return new Map();
			}

			const parsed = JSON.parse(jsonMatch[0]);
			return new Map(Object.entries(parsed) as Array<[string, string]>);
		} catch (error) {
			console.error("Failed to parse translation response:", error);
			return new Map();
		}
	}
}

/**
 * TermExpanderファクトリー関数
 */
export async function createTermExpander(): Promise<TermExpander> {
	const aiService = await new AIServiceBuilder().build();
	return new AITermExpander(aiService);
}
