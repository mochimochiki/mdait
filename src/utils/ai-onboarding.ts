/**
 * @file ai-onboarding.ts
 * @description AI機能の初回利用時のオンボーディング処理を管理するモジュール
 */

import * as vscode from "vscode";

/**
 * AI機能の初回利用チェックとオンボーディング表示を行うクラス
 */
export class AIOnboarding {
	private static instance: AIOnboarding | undefined;
	private globalState: vscode.Memento | undefined;
	private readonly FIRST_USE_KEY = "mdait.ai.firstUse";

	private constructor() {}

	/**
	 * シングルトンインスタンスを取得
	 */
	public static getInstance(): AIOnboarding {
		if (!AIOnboarding.instance) {
			AIOnboarding.instance = new AIOnboarding();
		}
		return AIOnboarding.instance;
	}

	/**
	 * 初期化処理（ExtensionContextから状態管理を取得）
	 */
	public initialize(context: vscode.ExtensionContext): void {
		this.globalState = context.globalState;
	}

	/**
	 * AI機能が初回利用かどうかをチェックし、初回の場合は説明ダイアログを表示
	 * @returns ユーザーが承認した場合はtrue、キャンセルした場合はfalse
	 */
	public async checkAndShowFirstUseDialog(): Promise<boolean> {
		if (!this.globalState) {
			// 初期化されていない場合はスキップ
			console.warn("AIOnboarding: globalState is not initialized");
			return true;
		}

		// 初回利用フラグを確認
		const hasUsedAIBefore = this.globalState.get<boolean>(this.FIRST_USE_KEY, false);

		if (hasUsedAIBefore) {
			// 既に利用経験がある場合はそのまま処理を続行
			return true;
		}

		// 初回利用の場合、説明ダイアログを表示
		const message = vscode.l10n.t(
			"This command uses AI to process your content.\n\n" +
				"AI Usage:\n" +
				"• Translation: AI translates your Markdown documents\n" +
				"• Term Detection: AI identifies important terms from your content\n" +
				"• Term Expansion: AI translates detected terms to other languages\n\n" +
				"Statistics logging is enabled by default to help you monitor AI usage.\n" +
				"You can disable it in mdait.json (ai.debug.enableStatsLogging).\n\n" +
				"Do you want to proceed?",
		);

		const proceedButton = vscode.l10n.t("Proceed");
		const cancelButton = vscode.l10n.t("Cancel");

		const result = await vscode.window.showInformationMessage(message, { modal: true }, proceedButton, cancelButton);

		if (result === proceedButton) {
			// ユーザーが承認した場合、フラグを保存
			await this.globalState.update(this.FIRST_USE_KEY, true);
			return true;
		}

		// ユーザーがキャンセルした場合
		return false;
	}

	/**
	 * テスト用: 初回利用フラグをリセット
	 */
	public async resetFirstUseFlag(): Promise<void> {
		if (this.globalState) {
			await this.globalState.update(this.FIRST_USE_KEY, undefined);
		}
	}

	/**
	 * テスト用: インスタンスをリセット
	 */
	public static reset(): void {
		AIOnboarding.instance = undefined;
	}
}
