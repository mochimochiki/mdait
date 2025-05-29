import type { AIMessage, AIService, MessageStream } from "../ai-service";
import type { AIProviderConfig } from "../ai-service-builder";

/**
 * AIServiceインターフェースのデフォルト実装（モック）。
 * 実際のAIプロバイダへの接続は行わず、固定の応答またはエコーバックを返します。
 * 主に開発初期段階やテスト用途での使用を想定しています。
 */
export class DefaultAIProvider implements AIService {
	private config: AIProviderConfig;

	constructor(config: AIProviderConfig) {
		this.config = config;
		console.log("DefaultAIProvider initialized with config:", config);
	}
	/**
	 * AIモデルに対してメッセージを送信し、ストリーミング応答を受け取ります。
	 * このデフォルト実装では、簡易的な翻訳モック応答を返します。
	 *
	 * @param systemPrompt システムプロンプト。
	 * @param messages AIモデルに送信するメッセージの配列。
	 * @returns モックのストリーミング応答。
	 */
	async *sendMessage(systemPrompt: string, messages: AIMessage[]): MessageStream {
		console.log(`DefaultAIProvider.sendMessage called with systemPrompt: ${systemPrompt}`);
		console.log(
			`DefaultAIProvider.sendMessage called with messages: ${JSON.stringify(messages, null, 2)}`,
		);

		// 翻訳対象のテキストを取得
		const userMessage = messages.find((msg) => msg.role === "user");
		const textToTranslate = (userMessage?.content as string) || "";

		// 簡易的な翻訳モック処理
		// 実際のAIプロバイダーでは、ここでAPIリクエストを行います
		const mockTranslatedText = this.generateMockTranslation(textToTranslate, systemPrompt);

		// ストリーミング形式で少しずつ応答を返す
		const chunks = this.splitIntoChunks(mockTranslatedText, 10);
		for (const chunk of chunks) {
			yield chunk;
			// 少し待機してストリーミングをシミュレート
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}

	/**
	 * 簡易的な翻訳モックを生成します。
	 */
	private generateMockTranslation(text: string, systemPrompt: string): string {
		// 英語から日本語への簡易的な置き換え
		if (systemPrompt.includes("to ja")) {
			return `${text
				.replace(/Hello/gi, "こんにちは")
				.replace(/World/gi, "世界")
				.replace(/Thank you/gi, "ありがとう")
				.replace(/Good morning/gi, "おはよう")
				.replace(/Good evening/gi, "こんばんは")
				.replace(/How are you/gi, "元気ですか")
				.replace(/The/gi, "その")
				.replace(/is/gi, "です")
				.replace(/are/gi, "です")}\n\n[このテキストはDefaultAIProviderによるモック翻訳です]`;
		}

		// その他の言語ペアの場合はプレフィックスを付けて返す
		return `${text}\n\n[このテキストはDefaultAIProviderによるモック翻訳です]`;
	}

	/**
	 * テキストを指定された文字数で分割します。
	 */
	private splitIntoChunks(text: string, chunkSize: number): string[] {
		const chunks: string[] = [];
		for (let i = 0; i < text.length; i += chunkSize) {
			chunks.push(text.slice(i, i + chunkSize));
		}
		return chunks;
	}
}
