import * as vscode from "vscode";
import type { AIConfig } from "../../config/configuration";
import type { AIMessage, AIService, MessageStream } from "../ai-service";

/**
 * VS Code Language Model API を使用した AI プロバイダー実装
 * GitHub Copilot の言語モデルを利用してチャット機能を提供します
 */
export class VSCodeLanguageModelProvider implements AIService {
	private config: AIConfig;

	constructor(config: AIConfig) {
		this.config = config;
		console.log("VSCodeLanguageModelProvider initialized with config:", config);
	}

	/**
	 * VS Code Language Model API を使用してメッセージを送信し、ストリーミング応答を受け取ります
	 *
	 * @param systemPrompt システムプロンプト
	 * @param messages ユーザーメッセージの配列
	 * @param cancellationToken キャンセル処理用トークン
	 * @returns ストリーミング応答
	 */
	async *sendMessage(
		systemPrompt: string,
		messages: AIMessage[],
		cancellationToken?: vscode.CancellationToken,
	): MessageStream {
		try {
			// 言語モデルを選択
			const model = await this.selectLanguageModel();
			if (!model) {
				throw new Error(vscode.l10n.t("Language model is not available. Please ensure GitHub Copilot is enabled."));
			}

			// VS Code Language Model API 用のプロンプトを作成
			const prompt = this.createPrompt(systemPrompt, messages);

			// リクエストを送信（cancellationTokenがあればそれを使用、なければ新規作成）
			const token = cancellationToken || new vscode.CancellationTokenSource().token;
			const response = await model.sendRequest(prompt, {}, token);

			// ストリーミングレスポンスを処理
			for await (const fragment of response.text) {
				yield fragment;
			}
		} catch (error) {
			if (error instanceof vscode.LanguageModelError) {
				console.log("Language model error:", error.message, error.code, error.cause);

				// エラーの種類に応じた適切なメッセージを生成
				if (error.cause instanceof Error && error.cause.message.includes("off_topic")) {
					yield vscode.l10n.t("Sorry, I cannot answer that question.");
				} else if (error.message.includes("consent")) {
					throw new Error(vscode.l10n.t("GitHub Copilot permission is required. Please check your settings."));
				} else if (error.message.includes("quota")) {
					throw new Error(vscode.l10n.t("API usage limit reached. Please try again later."));
				} else {
					throw new Error(vscode.l10n.t("Language model error: {0}", error.message));
				}
			} else {
				console.error("Unexpected error:", error);
				// エラーが既にErrorインスタンスの場合は、そのまま再スローして元のメッセージを保持
				if (error instanceof Error) {
					throw error;
				}
				const errorMessage = String(error);
				throw new Error(vscode.l10n.t("An unexpected error occurred: {0}", errorMessage));
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
	private createPrompt(systemPrompt: string, messages: AIMessage[]): vscode.LanguageModelChatMessage[] {
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
