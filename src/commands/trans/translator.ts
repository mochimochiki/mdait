import type { AIMessage, AIService } from "../../api/ai-service";
import type { TranslationContext } from "./translation-context";

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
	 */
	translate(
		text: string,
		sourceLang: string,
		targetLang: string,
		context: TranslationContext,
	): Promise<string>;
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
	 */
	public async translate(
		text: string,
		sourceLang: string,
		targetLang: string,
		context: TranslationContext,
	): Promise<string> {
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
		// @important design.md に記載の通り、glossary や surroundingText を活用すること
		const systemPrompt = `You are a professional translator. Translate the given text from ${sourceLang} to ${targetLang}.
Context:
${context.surroundingText ? `Surrounding Text:\n${context.surroundingText}\n` : ""}
${context.glossary ? `Glossary:\n${JSON.stringify(context.glossary, null, 2)}\n` : ""}
Keep the original meaning and tone.
Do not translate placeholders like __CODE_BLOCK_PLACEHOLDER_n__.`;

		const messages: AIMessage[] = [
			{
				role: "user",
				content: textWithoutCodeBlocks,
			},
		];

		// aiService.sendMessage() の呼び出しと MessageStream の処理
		const stream = this.aiService.sendMessage(systemPrompt, messages);
		let translatedText = "";
		for await (const chunk of stream) {
			// chunk は string 型なので、直接結合する
			translatedText += chunk;
		}

		// プレースホルダーをコードブロックに戻す
		let result = translatedText;
		for (let i = 0; i < placeholders.length; i++) {
			result = result.replace(placeholders[i], codeBlocks[i]);
		}

		return result;
	}
}
