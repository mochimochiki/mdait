import * as vscode from "vscode";
import type { AIMessage, AIService } from "../../api/ai-service";
import { AIServiceBuilder } from "../../api/ai-service-builder";

/**
 * chat command
 * VS Code Language Model API を使用してユーザーの質問に回答する
 */
export async function chatCommand(): Promise<void> {
	try {
		const chatHandler = new ChatCommand();
		await chatHandler.execute();
	} catch (error) {
		console.error("Chat command error:", error);
		vscode.window.showErrorMessage(
			vscode.l10n.t("An error occurred during chat processing: {0}", (error as Error).message),
		);
	}
}

/**
 * ChatCommand クラス
 * AIServiceを使用したチャット機能を提供する
 */
export class ChatCommand {
	/**
	 * メインの処理フロー
	 */
	async execute(): Promise<void> {
		// ユーザーからの質問を取得
		const userQuestion = await this.getUserInput();
		if (!userQuestion) {
			return; // ユーザーがキャンセルした場合は終了
		}

		try {
			// AIサービスを構築（VSCode Language Modelプロバイダーを使用）
			const aiServiceBuilder = new AIServiceBuilder();
			const aiService = await aiServiceBuilder.build({
				model: "vscode-lm",
			});

			// メッセージを準備
			const messages: AIMessage[] = [
				{
					role: "user",
					content: userQuestion,
				},
			];
      
      // システムプロンプト
			const systemPrompt = vscode.l10n.t(
				"You are a helpful and knowledgeable assistant. Please provide accurate and easy-to-understand answers to user questions in Japanese.",
			);

			// AIサービスに問い合わせ、レスポンスを表示
			await this.sendRequestAndDisplayResponse(aiService, systemPrompt, messages);
		} catch (error) {
			console.error("AI Service error:", error);
			vscode.window.showErrorMessage(
				vscode.l10n.t("AI service error: {0}", (error as Error).message),
			);
		}
	}

	/**
	 * ユーザーからの質問入力を取得
	 */
	private async getUserInput(): Promise<string | undefined> {
		return await vscode.window.showInputBox({
			prompt: "何について聞きたいですか？",
			placeHolder: "質問を入力してください...",
			ignoreFocusOut: true,
		});
	}

	/**
	 * AIサービスにリクエストを送信し、レスポンスを表示
	 */
	private async sendRequestAndDisplayResponse(
		aiService: AIService,
		systemPrompt: string,
		messages: AIMessage[],
	): Promise<void> {
		try {
			// 新しいエディタタブで回答を表示
			const document = await vscode.workspace.openTextDocument({
				content: "",
				language: "markdown",
			});
			const editor = await vscode.window.showTextDocument(document);

			// ストリーミングレスポンスを処理
			const responseStream = aiService.sendMessage(systemPrompt, messages);
			for await (const fragment of responseStream) {
				await editor.edit((editBuilder) => {
					const position = new vscode.Position(
						editor.document.lineCount - 1,
						editor.document.lineAt(editor.document.lineCount - 1).text.length,
					);
					editBuilder.insert(position, fragment);
				});
			}
		} catch (error) {
			console.error("Response display error:", error);
			vscode.window.showErrorMessage(`回答の表示中にエラーが発生しました: ${error}`);
		}
	}
}
