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
	/** 理由や説明 */
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
		const systemPrompt = `You are a professional translator. Translate the given text from ${sourceLang} to ${targetLang}.

Context:
${context.surroundingText ? `Surrounding Text:\n${context.surroundingText}\n` : ""}
${context.terms ? `Terminology:\n${context.terms}\n` : ""}

Instructions:
1. Translate the text accurately, keeping the original meaning and tone.
2. Do not translate placeholders like __CODE_BLOCK_PLACEHOLDER_n__.
3. After the translation, identify technical terms, proper nouns, or domain-specific terminology that appear in the original text but are NOT in the provided terminology list.
4. Return your response in the following JSON format:

{
  "translation": "your translated text here",
  "termSuggestions": [
    {
      "source": "original term",
      "target": "translated term",
      "reason": "why this should be added to glossary"
    }
  ]
}

Important: Return ONLY valid JSON. Do not include any markdown code blocks or explanations outside the JSON structure.`;

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
	private parseAIResponse(
		rawResponse: string,
		codeBlocks: string[],
		placeholders: string[],
	): TranslationResult {
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
