import * as vscode from "vscode";
import type { AIMessage, AIService, MessageStream } from "../ai-service";
import type { AIServiceConfig } from "../ai-service-builder";

/**
 * VS Code Language Model API を使用した AI プロバイダー実装
 * GitHub Copilot の言語モデルを利用してチャット機能を提供します
 */
export class VSCodeLanguageModelProvider implements AIService {
	private config: AIServiceConfig;

	constructor(config: AIServiceConfig) {
		this.config = config;
		console.log("VSCodeLanguageModelProvider initialized with config:", config);
	}

	/**
	 * VS Code Language Model API を使用してメッセージを送信し、ストリーミング応答を受け取ります
	 *
	 * @param systemPrompt システムプロンプト
	 * @param messages ユーザーメッセージの配列
	 * @returns ストリーミング応答
	 */
	async *sendMessage(systemPrompt: string, messages: AIMessage[]): MessageStream {
		try {
			// 言語モデルを選択
			const model = await this.selectLanguageModel();
			if (!model) {
				throw new Error(
					"Language model is not available. Please ensure GitHub Copilot is enabled.",
				);
			}

			// VS Code Language Model API 用のプロンプトを作成
			const prompt = this.createPrompt(systemPrompt, messages);

			// リクエストを送信
			const response = await model.sendRequest(
				prompt,
				{},
				new vscode.CancellationTokenSource().token,
			);

			// ストリーミングレスポンスを処理
			for await (const fragment of response.text) {
				yield fragment;
			}
		} catch (error) {
			if (error instanceof vscode.LanguageModelError) {
				console.log("Language model error:", error.message, error.code, error.cause);

				// エラーの種類に応じた適切なメッセージを生成
				if (error.cause instanceof Error && error.cause.message.includes("off_topic")) {
					yield "申し訳ありませんが、その質問にはお答えできません。";
				} else if (error.message.includes("consent")) {
					throw new Error("GitHub Copilot の使用許可が必要です。設定を確認してください。");
				} else if (error.message.includes("quota")) {
					throw new Error("API の使用制限に達しました。しばらく時間をおいてからお試しください。");
				} else {
					throw new Error(`言語モデルエラー: ${error.message}`);
				}
			} else {
				console.error("Unexpected error:", error);
				throw new Error(`予期しないエラーが発生しました: ${error}`);
			}
		}
	}

	/**
	 * 適切な言語モデルを選択
	 */
	private async selectLanguageModel(): Promise<vscode.LanguageModelChat | undefined> {
		try {
			// 設定されたモデルがある場合はそれを優先
			if (this.config.model) {
				const models = await vscode.lm.selectChatModels({
					vendor: "copilot",
					family: this.config.model,
				});
				if (models.length > 0) {
					return models[0];
				}
			}

			// gpt-4o
			const defaultModels = await vscode.lm.selectChatModels({
				vendor: "copilot",
				family: "gpt-4o",
			});
			if (defaultModels.length > 0) {
				return defaultModels[0];
			}

			// どのモデルも利用できない場合は、vendor のみで選択
			const fallbackModels = await vscode.lm.selectChatModels({
				vendor: "copilot",
			});

			return fallbackModels.length > 0 ? fallbackModels[0] : undefined;
		} catch (error) {
			console.error("Language model selection error:", error);
			return undefined;
		}
	}

	/**
	 * VS Code Language Model API 用のプロンプトを作成
	 */
	private createPrompt(
		systemPrompt: string,
		messages: AIMessage[],
	): vscode.LanguageModelChatMessage[] {
		const vscodeMessages: vscode.LanguageModelChatMessage[] = [];

		// システムプロンプトをAssistantに追加（VS Code LM API はSystemをサポートしていないため）
		if (systemPrompt) {
			vscodeMessages.push(vscode.LanguageModelChatMessage.Assistant(systemPrompt));
		}

		// その他のメッセージを変換
		for (const message of messages) {
			const content = Array.isArray(message.content) ? message.content.join("\n") : message.content;

			if (message.role === "user") {
				vscodeMessages.push(vscode.LanguageModelChatMessage.User(content));
			} else if (message.role === "assistant") {
				vscodeMessages.push(vscode.LanguageModelChatMessage.Assistant(content));
			}
		}

		return vscodeMessages;
	}
}
