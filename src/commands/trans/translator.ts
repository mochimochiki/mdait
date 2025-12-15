import type { AIMessage, AIService } from "../../api/ai-service";
import type { TranslationContext } from "./translation-context";

/**
 * 用語候補情報
 */
export interface TermSuggestion {
	/** 原語 */
	source: string;
	/** 訳語 */
	target: string;
	/** 用語が使用されている実際の文脈（原文からの引用） */
	context: string;
	/** 用語集に追加すべき理由（オプショナル） */
	reason?: string;
}

/**
 * 翻訳結果
 * 翻訳されたテキストと追加のメタデータを含む
 */
export interface TranslationResult {
	/** 翻訳されたテキスト */
	translatedText: string;
	/** AIが提案する用語候補のリスト */
	termSuggestions?: TermSuggestion[];
	/** 警告メッセージ */
	warnings?: string[];
	/** 統計情報（将来の拡張用） */
	stats?: {
		/** 推定使用トークン数 */
		estimatedTokens?: number;
	};
}

/**
 * 翻訳サービスのインターフェース
 */
export interface Translator {
	/**
	 * テキストを翻訳する
	 * @param text 翻訳対象のテキスト
	 * @param sourceLang 翻訳元の言語コード
	 * @param targetLang 翻訳先の言語コード
	 * @param context 翻訳コンテキスト
	 * @returns 翻訳結果（翻訳テキストと追加メタデータ）
	 */
	translate(
		text: string,
		sourceLang: string,
		targetLang: string,
		context: TranslationContext,
	): Promise<TranslationResult>;
}

/**
 * デフォルトの翻訳サービス
 */
export class DefaultTranslator implements Translator {
	private readonly aiService: AIService;

	constructor(aiService: AIService) {
		this.aiService = aiService;
	}

	/**
	 * テキストを翻訳する
	 * @param text 翻訳対象のテキスト
	 * @param sourceLang 翻訳元の言語コード
	 * @param targetLang 翻訳先の言語コード
	 * @param context 翻訳コンテキスト
	 * @returns 翻訳結果（翻訳テキストと追加メタデータ）
	 */
	public async translate(
		text: string,
		sourceLang: string,
		targetLang: string,
		context: TranslationContext,
	): Promise<TranslationResult> {
		// コードブロックをスキップするロジック
		const codeBlockRegex = /```[\s\S]*?```/g;
		const codeBlocks: string[] = [];
		const placeholders: string[] = [];

		const textWithoutCodeBlocks = text.replace(codeBlockRegex, (match) => {
			const placeholder = `__CODE_BLOCK_PLACEHOLDER_${codeBlocks.length}__`;
			codeBlocks.push(match);
			placeholders.push(placeholder);
			return placeholder;
		});

		// systemPrompt と AIMessage[] の構築
		// @important design.md に記載の通り、terms や surroundingText を活用すること
		const systemPrompt = `You are a professional translator specializing in Markdown documents.

Your task is to translate the given text from ${sourceLang} to ${targetLang}.

CRITICAL RULE (HIGHEST PRIORITY):
- You MUST preserve the original Markdown structure EXACTLY.
- Breaking Markdown structure is strictly forbidden, even if the translation itself is correct.

Context:
${context.surroundingText ? `Surrounding Text (for reference only, do NOT translate unless included in the target text):\n${context.surroundingText}\n` : ""}
${context.terms ? `Terminology (preferred translations):\n${context.terms}\n` : ""}
${context.previousTranslation ? `Previous Translation (for reference - the source text was revised):\n${context.previousTranslation}\n\nIMPORTANT: The source text has been revised. Please refer to the previous translation and:\n- Keep sentences/phrases that don't need to be changed (respect the existing translation)\n- Only modify the parts that need to be updated based on the source text changes\n- Maintain consistency with the unchanged parts of the previous translation\n` : ""}

Markdown Preservation Rules:
1. DO NOT add, remove, or modify any Markdown syntax, including but not limited to:
  - Headings: #, ##, ###, ####
  - Lists: -, *, +, 1., 2., etc.
  - All other Markdown syntaxes
2. Keep line breaks, blank lines, and indentation exactly as in the original text.
3. Only translate the human-readable text content inside the Markdown structure.
4. Do NOT translate placeholders such as __CODE_BLOCK_PLACEHOLDER_n__.
5. If a line contains both Markdown syntax and text, translate ONLY the text portion and leave all symbols untouched.
6. If you are unsure whether something is Markdown syntax, assume it IS and do NOT modify it.

Translation Instructions:
1. Translate accurately while preserving meaning, tone, and technical correctness.
2. Follow the provided terminology list strictly when applicable.
3. After translation, identify technical terms, proper nouns, or domain-specific terms that:
  - Appear in the ORIGINAL text
  - Are NOT included in the provided terminology list

Self-Check (MANDATORY before responding):
- Verify that the number of lines is unchanged.
- Verify that all Markdown symbols remain in the same positions.
- Verify that no Markdown elements were removed or altered.

Response Format:
Return ONLY valid JSON in the following format. Do NOT include markdown code blocks or explanations outside JSON.

{
  "translation": "the translated text with Markdown structure perfectly preserved",
  "termSuggestions": [
    {
      "source": "original term in ${sourceLang}",
      "target": "translated term in ${targetLang}",
      "context": "an actual sentence or phrase quoted directly from the ORIGINAL text including the source term (LANGUAGE: ${sourceLang})",
      "reason": "(optional) brief explanation why this term should be added to glossary"
    }
  ]
}

Important Notes:
- The \"context\" field MUST quote the original text verbatim.
- Return ONLY valid JSON. Any extra text invalidates the response.`;

		const messages: AIMessage[] = [
			{
				role: "user",
				content: textWithoutCodeBlocks,
			},
		];

		// aiService.sendMessage() の呼び出しと MessageStream の処理
		const stream = this.aiService.sendMessage(systemPrompt, messages);
		let rawResponse = "";
		for await (const chunk of stream) {
			// chunk は string 型なので、直接結合する
			rawResponse += chunk;
		}

		// JSON応答をパース
		const result = this.parseAIResponse(rawResponse, codeBlocks, placeholders);
		return result;
	}

	/**
	 * AIの応答をパースしてTranslationResultを生成
	 * @param rawResponse AIからの生の応答
	 * @param codeBlocks 保存されたコードブロック
	 * @param placeholders プレースホルダーのリスト
	 * @returns パースされた翻訳結果
	 */
	private parseAIResponse(rawResponse: string, codeBlocks: string[], placeholders: string[]): TranslationResult {
		try {
			// マークダウンのコードブロックを除去（```json ... ``` のような形式に対応）
			const jsonMatch = rawResponse.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
			const jsonString = jsonMatch ? jsonMatch[1] : rawResponse;

			const parsed = JSON.parse(jsonString.trim());

			// プレースホルダーをコードブロックに戻す
			let translatedText = parsed.translation || rawResponse;
			for (let i = 0; i < placeholders.length; i++) {
				translatedText = translatedText.replace(placeholders[i], codeBlocks[i]);
			}

			return {
				translatedText,
				termSuggestions: parsed.termSuggestions || [],
				warnings: parsed.warnings,
			};
		} catch (error) {
			// JSONパースに失敗した場合は、生のテキストを翻訳として使用
			console.warn("Failed to parse AI response as JSON, using raw text:", error);

			let translatedText = rawResponse;
			for (let i = 0; i < placeholders.length; i++) {
				translatedText = translatedText.replace(placeholders[i], codeBlocks[i]);
			}

			return {
				translatedText,
				termSuggestions: [],
				warnings: ["AI response format was unexpected"],
			};
		}
	}
}
