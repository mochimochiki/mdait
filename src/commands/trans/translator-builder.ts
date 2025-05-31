import { AIServiceBuilder, type AIServiceConfig } from "../../api/ai-service-builder";
import { DefaultTranslator, type Translator } from "./translator";

/**
 * 翻訳サービスの構築を担当するビルダークラス。
 * AIServiceBuilderを利用してAIServiceを構築し、それを基に翻訳サービスを提供します。
 */
export class TranslatorBuilder {
	/**
	 * 設定に基づいて翻訳サービスのインスタンスを構築します。
	 *
	 * @param config AIプロバイダの設定。指定されない場合はVSCodeの設定から読み込みます。
	 * @returns Translator のインスタンス。
	 * @throws サポートされていないプロバイダが指定された場合。
	 */
	public async build(config?: AIServiceConfig): Promise<Translator> {
		const aiService = await new AIServiceBuilder().build(config);
		return new DefaultTranslator(aiService);
	}
}
