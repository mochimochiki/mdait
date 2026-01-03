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
			"AI_Usage_Confirmation",
		);

		const proceedButton = vscode.l10n.t("Proceed");

		const result = await vscode.window.showInformationMessage(message, { modal: true }, proceedButton);

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
