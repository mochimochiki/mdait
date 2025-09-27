/**
 * @file term-detector.ts
 * @description 用語検出に特化したサービス
 * 原文から重要用語を検出し、context情報と共に用語候補リストを生成
 */

import type { AIService } from "../../api/ai-service";
import { AIServiceBuilder } from "../../api/ai-service-builder";
import type { MdaitUnit } from "../../core/markdown/mdait-unit";
import { MockTermDetector } from "./mock-term-detector";
import type { TermEntry } from "./term-entry";
import { TermEntry as TermEntryUtils } from "./term-entry";

/**
 * 用語検出サービスのインターフェース
 */
export interface TermDetector {
	/**
	 * MdaitUnitから重要用語を検出
	 *
	 * @param unit 検出対象のユニット
	 * @param lang 言語コード
	 * @returns 検出された用語エントリのリスト
	 */
	detectTerms(unit: MdaitUnit, lang: string): Promise<readonly TermEntry[]>;
}

/**
 * AIサービスを使用する用語検出実装
 */
export class AITermDetector implements TermDetector {
	private readonly aiService: AIService;
	private readonly fallbackDetector: MockTermDetector;

	constructor(aiService: AIService) {
		this.aiService = aiService;
		this.fallbackDetector = new MockTermDetector();
	}

	/**
	 * MdaitUnitから用語検出
	 * シンプルな実装で、ユニットのcontentから用語を検出
	 */
	async detectTerms(unit: MdaitUnit, lang: string): Promise<readonly TermEntry[]> {
		const content = unit.content;
		const systemPrompt = `You are a terminology extraction expert. Extract important technical terms, concepts, and specialized vocabulary from the given text.

Instructions:
- Extract 3-7 most important technical terms, concepts, or specialized vocabulary
- Focus on terms that would benefit from consistent translation or usage
- Include technical terms, product names, UI elements, and domain-specific concepts
- For each term, provide appropriate context explaining its meaning or usage

Return JSON array with this structure:
[
  {
    "term": "extracted term",
    "context": "explanation of the term's meaning and usage context"
  }
]`;

		const userPrompt = `Extract important terms from this text:

Text:
${content}

Return the JSON array of extracted terms:`;

		// ストリーミング応答を文字列に結合
		let response = "";
		const messageStream = this.aiService.sendMessage(systemPrompt, [{ role: "user", content: userPrompt }]);

		for await (const chunk of messageStream) {
			response += chunk;
		}

		return this.parseAIResponse(response, lang);
	}

	/**
	 * AI応答をTermEntryの配列に変換
	 */
	private parseAIResponse(response: string, lang: string): readonly TermEntry[] {
		try {
			// JSONブロックを抽出
			const jsonMatch = response.match(/\[[\s\S]*\]/);
			if (!jsonMatch) {
				throw new Error("JSONブロックが見つかりません");
			}

			const parsed = JSON.parse(jsonMatch[0]);
			if (!Array.isArray(parsed)) {
				throw new Error("配列形式ではありません");
			}

			return parsed
				.filter((item) => item.term && item.context)
				.map((item) =>
					TermEntryUtils.create(item.context, {
						[lang]: {
							term: item.term,
							variants: [],
						},
					}),
				);
		} catch (error) {
			console.warn("AI応答のパースに失敗しました:", error);
			return [];
		}
	}
}

/**
 * デフォルトの用語検出サービスを作成
 */
export async function createTermDetector(): Promise<TermDetector> {
	try {
		const builder = new AIServiceBuilder();
		const aiService = await builder.build();
		return new AITermDetector(aiService);
	} catch (error) {
		console.warn("AI用語検出サービスの初期化に失敗しました。モック実装を使用します:", error);
		return new MockTermDetector();
	}
}
