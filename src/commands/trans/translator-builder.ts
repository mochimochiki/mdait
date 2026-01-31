import { AIServiceBuilder } from "../../api/ai-service-builder";
import type { TransConfig } from "../../config/configuration";
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
		return new AITranslator(aiService);
	}
}
