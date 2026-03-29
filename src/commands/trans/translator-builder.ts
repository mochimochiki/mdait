import { Configuration } from "../../config/configuration";
import { AIServiceBuilder } from "../../llm/ai-service-builder";
import { PromptProvider } from "../../prompts";
import { AITranslator, type Translator } from "./translator";

/**
 * 翻訳サービスの構築を担当するビルダークラス。
 * AIServiceBuilderを利用してAIServiceを構築し、それを基に翻訳サービスを提供します。
 */
export class TranslatorBuilder {
	/**
	 * 設定に基づいて翻訳サービスのインスタンスを構築します。
	 *
	 * @returns Translator のインスタンス。
	 * @throws サポートされていないプロバイダが指定された場合。
	 */
	public async build(): Promise<Translator> {
		const aiService = await new AIServiceBuilder().build();
		const config = Configuration.getInstance();
		const promptProvider = PromptProvider.getInstance();
		return new AITranslator(aiService, config.getTermsPrimaryLang(), (id, variables) =>
			promptProvider.getPrompt(id, variables),
		);
	}
}
