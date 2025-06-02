import { Configuration, TransConfig } from "../config/configuration";
import type { AIMessage, AIService } from "./ai-service";
import { DefaultAIProvider } from "./providers/default-ai-provider"; // Placeholder for actual provider
import { OllamaProvider } from "./providers/ollama-provider";
import { VSCodeLanguageModelProvider } from "./providers/vscode-lm-provider";

/**
 * 設定に基づいて適切な AIService の実装を生成するビルダークラス。
 */
export class AIServiceBuilder {
	/**
	 * 指定された設定に基づいて AIService のインスタンスを構築します。
	 *
	 * @param config AIプロバイダの設定。指定されない場合はVSCodeの設定から読み込みます。
	 * @returns AIService のインスタンス。
	 * @throws サポートされていないプロバイダが指定された場合。
	 */
	public async build(config?: TransConfig): Promise<AIService> {
		const effectiveConfig = config || (await this.loadConfiguration());
		switch (effectiveConfig.provider) {
			case "default":
				return new DefaultAIProvider(effectiveConfig);
			case "vscode-lm":
				return new VSCodeLanguageModelProvider(effectiveConfig);
			case "ollama":
				return new OllamaProvider(effectiveConfig);
			// case 'openai':
			//   return new OpenAIAIProvider(effectiveConfig.apiKey);
			// case 'anthropic':
			//   return new AnthropicAIProvider(effectiveConfig.apiKey);
			default:
				throw new Error(`Unsupported AI provider: ${effectiveConfig.provider}`);
		}
	}
	
  /**
	 * VSCodeの設定からAIプロバイダ設定を読み込みます。
	 */
  private async loadConfiguration(): Promise<TransConfig> {
		const config = new Configuration();
		await config.load();

		return config.trans;
	}
}
