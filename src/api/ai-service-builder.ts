import { Configuration } from "../config/configuration";
import type { AIMessage, AIService } from "./ai-service";
import { DefaultAIProvider } from "./providers/default-ai-provider"; // Placeholder for actual provider
import { VSCodeLanguageModelProvider } from "./providers/vscode-lm-provider";

/**
 * AIプロバイダの設定を表すインターフェース。
 * `mdait.trans.provider` の設定値や、各プロバイダ固有の設定（APIキーなど）を想定。
 */
export interface AIServiceConfig {
	provider?: string; // プロバイダ種別: "default", "vscode-lm", "openai" など
	model?: string; // 使用するモデル名。"gpt-4o"など
	apiKey?: string; // 例: OpenAI APIキーなど
	// 他のプロバイダ固有設定
	[key: string]: unknown;
}

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
	 */ public async build(config?: AIServiceConfig): Promise<AIService> {
		const effectiveConfig = config || (await this.loadConfiguration());
		switch (effectiveConfig.provider) {
			case "default":
				return new DefaultAIProvider(effectiveConfig);
			case "vscode-lm":
				return new VSCodeLanguageModelProvider(effectiveConfig);
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
	 */ private async loadConfiguration(): Promise<AIServiceConfig> {
		const config = new Configuration();
		await config.load();

		const provider = config.trans.provider || "default";
		const model = config.trans.model || "gpt-4o";
		// TODO: APIキーやその他のプロバイダ固有設定をVSCode設定から読み込む
		// const apiKey = config.get<string>(`trans.providers.${provider}.apiKey`);

		return {
			provider,
			model,
			// apiKey,
		};
	}
}
