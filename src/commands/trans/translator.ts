import type { AIMessage, AIService } from "../../api/ai-service";
import { Configuration } from "../../config/configuration";
import { PromptIds, PromptProvider } from "../../prompts";
import type { TranslationContext } from "./translation-context";

/**
 * 用語候補情報
 */
export interface TermSuggestion {
	/** 原語 */
	source: string;
	/** 訳語 */
	target: string;
	/** 用語が使用されている実際の文脈（contextLang言語からの引用） */
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

		// contextLangを決定: primaryLangがsourceLangかtargetLangなら使用、そうでなければsourceLang
		const config = Configuration.getInstance();
		const primaryLang = config.getTermsPrimaryLang();
		const contextLang =
			primaryLang === sourceLang || primaryLang === targetLang ? primaryLang : sourceLang;

		// systemPrompt と AIMessage[] の構築
		// @important design.md に記載の通り、terms や surroundingText を活用すること
		const promptProvider = PromptProvider.getInstance();
		const systemPrompt = promptProvider.getPrompt(PromptIds.TRANS_TRANSLATE, {
			sourceLang,
			targetLang,
			contextLang,
			surroundingText: context.surroundingText,
			terms: context.terms,
			previousTranslation: context.previousTranslation,
			sourceDiff: context.sourceDiff,
		});

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
