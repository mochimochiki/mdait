import { type AIConfig, Configuration } from "../config/configuration";
import type { AIService } from "./ai-service";
import { withAiCallGuard } from "./call-budget";
import { DefaultAIProvider } from "./providers/default-ai-provider";
import { OllamaProvider } from "./providers/ollama-provider";
import { OpenAIProvider } from "./providers/openai-provider";
import { VSCodeLanguageModelProvider } from "./providers/vscode-lm-provider";

/**
 * 設定に基づいて適切な AIService の実装を生成するビルダークラス。
 */
export class AIServiceBuilder {
	/**
	 * 指定された設定に基づいて AIService のインスタンスを構築します。
	 *
	 * 返すのは必ず**歯止め付き**の AIService（`withAiCallGuard`）。AI を呼ぶ経路は
	 * すべてここを通るので、呼び過ぎを見張る場所はここ 1 か所でよい（`call-budget.ts`）。
	 *
	 * @param config AIプロバイダの設定。指定されない場合はVSCodeの設定から読み込みます。
	 * @returns AIService のインスタンス。
	 * @throws サポートされていないプロバイダが指定された場合。
	 */
	public async build(config?: AIConfig): Promise<AIService> {
		return withAiCallGuard(await this.buildProvider(config));
	}

	private async buildProvider(config?: AIConfig): Promise<AIService> {
		const effectiveConfig = config || (await this.loadConfiguration());
		switch (effectiveConfig.provider) {
			case "default":
				return new DefaultAIProvider(effectiveConfig);
			case "vscode-lm":
				return new VSCodeLanguageModelProvider(effectiveConfig);
			case "ollama":
				return new OllamaProvider(effectiveConfig);
			case "openai":
				return new OpenAIProvider(effectiveConfig);
			// case 'anthropic':
			//   return new AnthropicAIProvider(effectiveConfig.apiKey);
			default:
				throw new Error(`Unsupported AI provider: ${effectiveConfig.provider}`);
		}
	}

	/**
	 * VSCodeの設定からAIプロバイダ設定を読み込みます。
	 */
	private async loadConfiguration(): Promise<AIConfig> {
		const config = Configuration.getInstance();

		return config.ai;
	}
}
