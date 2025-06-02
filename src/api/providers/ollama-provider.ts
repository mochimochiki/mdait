import { Ollama } from "ollama";
import type { AIMessage, AIService, MessageStream } from "../ai-service";
import type { TransConfig } from "../../config/configuration";

/**
 * Ollama-js パッケージを使用した AI プロバイダー実装
 * ローカルで実行されるOllamaサーバーと通信してテキスト生成を行います
 */
export class OllamaProvider implements AIService {
	private ollama: Ollama;
	private model: string;

	constructor(config: TransConfig) {
		// Ollama固有設定を優先、フォールバックとして汎用設定を使用
		const endpoint = (config.ollama?.endpoint as string) || "http://localhost:11434";
		this.model = (config.ollama?.model as string) || (config.model as string) || "llama2";

		// Ollama クライアントを初期化
		this.ollama = new Ollama({ host: endpoint });
	}
	/**
	 * Ollamaサーバーに対してメッセージを送信し、ストリーミング応答を受け取ります。
	 *
	 * @param systemPrompt システムプロンプト
	 * @param messages メッセージ履歴
	 * @returns ストリーミング応答のAsyncGenerator
	 */
	async *sendMessage(systemPrompt: string, messages: AIMessage[]): MessageStream {
		try {
			// ユーザーメッセージを取得
			const userMessage = messages.find((msg) => msg.role === "user");
			const userContent = (userMessage?.content as string) || "";

			// システムプロンプトとユーザーメッセージを結合
			const prompt = systemPrompt ? `${systemPrompt}\n\n${userContent}` : userContent;

			// Ollama-js パッケージを使用してストリーミング生成
			const stream = await this.ollama.generate({
				model: this.model,
				prompt: prompt,
				stream: true,
				options: {
					temperature: 0.7,
					top_p: 0.9,
				},
			});

			// ストリーミングレスポンスを処理
			for await (const chunk of stream) {
				if (chunk.response) {
					yield chunk.response;
				}
				if (chunk.done) {
					break;
				}
			}
		} catch (error) {
			throw new Error(`Ollama provider error: ${(error as Error).message}`);
		}
	}
}
