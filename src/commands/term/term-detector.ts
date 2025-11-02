/**
 * @file term-detector.ts
 * @description 用語検出に特化したサービス
 * 原文から重要用語を検出し、context情報と共に用語候補リストを生成
 */

import type * as vscode from "vscode";
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
	 * 複数のMdaitUnitから重要用語をバッチ検出
	 *
	 * @param units 検出対象のユニット配列
	 * @param lang 言語コード
	 * @param existingTerms repository に既に存在するエントリのリスト
	 * @param cancellationToken キャンセル処理用トークン
	 * @returns 検出された用語エントリのリスト
	 */
	detectTermsBatch(
		units: readonly MdaitUnit[],
		lang: string,
		existingTerms?: readonly TermEntry[],
		cancellationToken?: vscode.CancellationToken,
	): Promise<readonly TermEntry[]>;
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
	 * 複数のMdaitUnitから用語をバッチ検出
	 * 全ユニットの内容をまとめて1回のAI呼び出しで処理
	 */
	async detectTermsBatch(
		units: readonly MdaitUnit[],
		lang: string,
		existingTerms?: readonly TermEntry[],
		cancellationToken?: vscode.CancellationToken,
	): Promise<readonly TermEntry[]> {
		if (units.length === 0) {
			return [];
		}

		// 既存用語情報の準備
		let existingInfo = "";
		if (existingTerms && existingTerms.length > 0) {
			const termsList = existingTerms
				.filter((e) => e.languages[lang])
				.map((e) => e.languages[lang].term)
				.slice(0, 50); // 長すぎないように制限
			if (termsList.length > 0) {
				existingInfo = `The following terms are already present in the terminology repository for this language:\n- ${termsList.join("\n- ")}\n\n`;
			}
		}

		// 複数ユニットの内容を結合
		const combinedContent = units
			.map((unit, idx) => {
				const title = unit.title || `Section ${idx + 1}`;
				return `## ${title}\n${unit.content}`;
			})
			.join("\n\n");

		const systemPrompt = `You are a terminology extraction expert. Your task is to identify and describe important terms from the given text.
Instructions: 
- Read the entire text carefully.
- Extract **all important technical terms, product names, UI elements, or domain-specific concepts** that would benefit from consistent translation or terminology management. 
- **Do not omit clearly identifiable terms even if it exceeds the reference count range.** 
- Avoid generic words, verbs, or adjectives. 

### Adaptive scaling rule: Use the following as guidelines, not strict limits: 
- Short text (< 500 characters): usually 3–10 terms 
- Medium text (500–2,000 characters): usually 10–20 terms 
- Long text (> 2,000 characters): usually 20–40 terms 
→ However, if more valid terms are clearly present, include them all. 

### Term identification criteria: 

Extract a term **if it meets at least one of the following conditions:** 
1. **Domain specificity** – Used primarily in a technical, scientific, or professional field.
2. **Terminological stability** – The meaning should stay consistent across translations or contexts. 
3. **Reference utility** – A reader would benefit from a consistent translation or note. 
4. **Distinctness** – It denotes a named concept, method, parameter, feature, or entity (not just descriptive language). 
5. **Referential use** – The term could plausibly appear in documentation, UI labels, manuals, or academic writing. 

### Output rules: 

- Return a deduplicated JSON array of objects: 
- "term": extracted term - "context": concise Japanese explanation of its meaning and usage 
- Do not include already-registered terms. 
- Keep explanations brief and accurate.
Instructions:
- Analyze the entire text carefully before extracting.
- Extract **important technical terms, product names, UI elements, domain-specific concepts, or proper nouns** that are likely to require consistent translation or usage.
- Avoid extracting:
  - Common words, generic verbs, or adjectives.
  - Terms already present in the existing terminology list.
  - Duplicated or contextually trivial mentions.

### Scaling rule:
- If the text is short (< 500 characters): extract up to 5 terms.
- If the text is medium (500–2,000 characters): extract up to 15 terms.
- If the text is long (> 2,000 characters): extract up to 30 terms, grouping similar ones if appropriate.

### Output rules:
- Each extracted term must have a concise **Japanese explanation (context)** explaining its meaning or usage within the text.
- Return a **deduplicated JSON array** of objects, each with:
  - "term": the extracted term
  - "context": its explanation (in the LANGUAGE: ${lang})
- Do not include terms already in the terminology repository below.

${existingInfo}Return JSON array with this structure:
[
  {
    "term": "extracted term",
    "context": "explanation of the term's meaning and usage context. Always return in the LANGUAGE: ${lang}."
  }
]`;

		const userPrompt = `Extract important terms from this text:

Text:
${combinedContent}

Return JSON array only, no commentary.`;

		// ストリーミング応答を文字列に結合
		let response = "";
		const messageStream = this.aiService.sendMessage(
			systemPrompt,
			[{ role: "user", content: userPrompt }],
			cancellationToken,
		);

		for await (const chunk of messageStream) {
			// キャンセルチェック
			if (cancellationToken?.isCancellationRequested) {
				console.log("Term detection was cancelled");
				return [];
			}
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
