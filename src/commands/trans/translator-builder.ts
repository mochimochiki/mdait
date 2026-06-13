import { Configuration } from "../../infra/config/configuration";
import { AIServiceBuilder } from "../../infra/llm/ai-service-builder";
import { PromptProvider } from "../../prompts";
import {
	AITranslator,
	PLAIN_PROMPT_CONFIG,
	type Translator,
} from "./translator";

/**
 * 翻訳サービスの構築を担当するビルダークラス。
 * AIServiceBuilderを利用してAIServiceを構築し、それを基に翻訳サービスを提供します。
 */
export class TranslatorBuilder {
	/**
	 * Markdown用翻訳サービスのインスタンスを構築します。
	 *
	 * @returns Translator のインスタンス。
	 * @throws サポートされていないプロバイダが指定された場合。
	 */
	public async build(): Promise<Translator> {
		const aiService = await new AIServiceBuilder().build();
		const config = Configuration.getInstance();
		const promptProvider = PromptProvider.getInstance();
		return new AITranslator(
			aiService,
			config.getTermsPrimaryLang(),
			(id, variables) => promptProvider.getPromptParts(id, variables),
		);
	}

	/**
	 * 非MDファイル用翻訳サービスのインスタンスを構築します。
	 * PlainFileHandler用のプロンプト設定を使用します。
	 *
	 * @returns Translator のインスタンス。
	 */
	public async buildPlain(): Promise<Translator> {
		const aiService = await new AIServiceBuilder().build();
		const config = Configuration.getInstance();
		const promptProvider = PromptProvider.getInstance();
		return new AITranslator(
			aiService,
			config.getTermsPrimaryLang(),
			(id, variables) => promptProvider.getPromptParts(id, variables),
			PLAIN_PROMPT_CONFIG,
		);
	}
}
