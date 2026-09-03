/**
 * @file ai-onboarding.ts
 * @description AI機能の初回利用時のオンボーディング処理を管理するモジュール
 */

import * as vscode from "vscode";
import { type AIConfig, Configuration } from "../config/configuration";
import { Logger } from "../logging/logger";

/**
 * 設定済みのAIサービスを「provider / vendor / model」形式の1行で表す。
 * 初回同意ダイアログで、ユーザーが何に同意するのかを具体的に示すために使う。
 * 各プロバイダ実装の既定値（vendor: copilot、ollama: llama2、openai: gpt-5-mini）に追従する。
 */
export function describeAiService(ai: AIConfig): string {
	switch (ai.provider) {
		case "vscode-lm":
		case "default":
			return [ai.provider, ai.vendor ?? "copilot", ai.model].filter(Boolean).join(" / ");
		case "ollama":
			return ["ollama", ai.ollama?.model || ai.model || "llama2"].filter(Boolean).join(" / ");
		case "openai":
			return ["openai", ai.model || "gpt-5-mini"].filter(Boolean).join(" / ");
		default:
			return [ai.provider, ai.model].filter(Boolean).join(" / ");
	}
}

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
		// デバッグIPC環境ではダイアログをスキップ（自動テスト対応）
		if (process.env.MDAIT_DEBUG_IPC === "1") {
			return true;
		}

		if (!this.globalState) {
			// 初期化されていない場合はスキップ
			Logger.getInstance().warn(
				"ai-onboarding",
				"globalState is not initialized",
			);
			return true;
		}

		// 初回利用フラグを確認
		const hasUsedAIBefore = this.globalState.get<boolean>(
			this.FIRST_USE_KEY,
			false,
		);

		if (hasUsedAIBefore) {
			// 既に利用経験がある場合はそのまま処理を続行
			return true;
		}

		// 初回利用の場合、説明ダイアログを表示
		const message = vscode.l10n.t(
			"✨ Commands marked with the sparkle icon use AI.\n\n  • The AI service specified in mdait.json will be used\n  • AI usage statistics are recorded in .mdait/ai-stats.log\n\nDo you want to continue?",
		);

		const proceedButton = vscode.l10n.t("Proceed");

		// どのAIサービスに同意するのかを具体的に示す（mdait.json の設定内容）
		const detail = vscode.l10n.t(
			"AI service: {0} (from mdait.json)",
			describeAiService(Configuration.getInstance().ai),
		);

		const result = await vscode.window.showInformationMessage(
			message,
			{ modal: true, detail },
			proceedButton,
		);

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
