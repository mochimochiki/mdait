/**
 * @file term-expander.ts
 * @description 用語展開サービス
 * 検出済み用語を対象言語に展開する（既存対訳優先、AI翻訳フォールバック）
 */

import type * as vscode from "vscode";
import type { MdaitUnit } from "../../core/markdown/mdait-unit";
import type { AIService } from "../../infra/llm/ai-service";
import { AIServiceBuilder } from "../../infra/llm/ai-service-builder";
import { UnusableAIResponseError } from "../../infra/llm/unusable-response";
import { PromptIds, PromptProvider } from "../../prompts";
import { parseJsonAnswer } from "../shared/ai-json";
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
			const response = await this.aiService.sendMessage(
				systemPrompt,
				[{ role: "user", content: userPrompt }],
				cancellationToken,
			);
			return this.parseExtractionResponse(response);
		} catch (error) {
			// AI呼び出しの失敗を「0件展開の成功」と誤認させないため握りつぶさず伝播させる
			console.error("Phase 2 batch extraction failed:", error);
			throw error;
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
			const response = await this.aiService.sendMessage(
				systemPrompt,
				[{ role: "user", content: userPrompt }],
				cancellationToken,
			);
			return this.parseTranslationResponse(response);
		} catch (error) {
			// AI呼び出しの失敗を「0件翻訳の成功」と誤認させないため握りつぶさず伝播させる
			console.error("Phase 2 translation failed:", error);
			throw error;
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
		return this.parseTermMap(response);
	}

	/**
	 * Phase 2のAIレスポンスをパース
	 */
	private parseTranslationResponse(response: string): Map<string, string> {
		return this.parseTermMap(response);
	}

	/**
	 * 応答から「原語 → 訳語」の対応表を取り出す。取り出せなければ**使えない答え**として断ち切る。
	 *
	 * **0件として飲み込まない。** 飲み込むと「訳語を埋められる用語が無かった」と区別が付かず、
	 * 利用者には「訳語 0 件を埋めました」としか伝わらない。何をしても進まないのに、
	 * 用語集のせいだと読める形で終わる。正しい0件は**空のオブジェクト**だけである。
	 */
	private parseTermMap(response: string): Map<string, string> {
		// JSON の読み方は `commands/shared/ai-json.ts` に寄せてある（フェンス優先・空は empty）
		const parsed = parseJsonAnswer(response, "Term expansion");
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw this.unusableResponse(response, "the JSON was not an object");
		}

		const pairs = Object.entries(parsed).filter(
			(entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0,
		);
		if (Object.keys(parsed).length > 0 && pairs.length === 0) {
			throw this.unusableResponse(response, "no entry mapped a term to a non-empty string");
		}
		return new Map(pairs);
	}

	/** 使えない答えを表す例外を作る（message は記録用の英語。利用者向けの文は呼び出し側が組む） */
	private unusableResponse(response: string, why: string): UnusableAIResponseError {
		return new UnusableAIResponseError(
			"invalid-format",
			`Term expansion response was not usable: ${why}`,
			`responseChars=${response.length}`,
		);
	}
}

/**
 * TermExpanderファクトリー関数
 */
export async function createTermExpander(): Promise<TermExpander> {
	const aiService = await new AIServiceBuilder().build();
	return new AITermExpander(aiService);
}
