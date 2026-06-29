/**
 * @file guidance.ts
 * @description エラー時に「次に何をすればよいか」をその場で示すための共通導線ヘルパー（次善策）。
 * showErrorMessage 等にアクションボタンを付与し、診断・Sync・ドキュメントへ誘導する。
 */

import * as vscode from "vscode";
import { Configuration } from "../../infra/config/configuration";

const TROUBLESHOOTING_URL =
	"https://github.com/mochimochiki/mdait/blob/main/docs/guide/ja/troubleshooting.md";

/** 設定ファイルを開く（無ければ作成コマンドへ） */
async function openConfigFile(): Promise<void> {
	const configPath = Configuration.getInstance().getConfigFilePath();
	if (configPath) {
		try {
			const doc = await vscode.workspace.openTextDocument(configPath);
			await vscode.window.showTextDocument(doc);
			return;
		} catch {
			// 開けない場合は作成コマンドにフォールバック
		}
	}
	await vscode.commands.executeCommand("mdait.setup.createConfig");
}

/** トラブルシューティングガイドを開く */
async function openDocs(): Promise<void> {
	await vscode.env.openExternal(vscode.Uri.parse(TROUBLESHOOTING_URL));
}

/**
 * 設定エラーを「診断」「mdait.json を開く」導線付きで表示する。
 */
export async function showConfigError(validationError: string): Promise<void> {
	const diagnose = vscode.l10n.t("Diagnose");
	const openConfig = vscode.l10n.t("Open mdait.json");
	const choice = await vscode.window.showErrorMessage(
		vscode.l10n.t("Configuration error: {0}", validationError),
		diagnose,
		openConfig,
	);
	if (choice === diagnose) {
		await vscode.commands.executeCommand("mdait.setup.diagnose");
	} else if (choice === openConfig) {
		await openConfigFile();
	}
}

/**
 * 「先に Sync が必要」系のエラーを「Sync を実行」「ドキュメント」導線付きで表示する。
 * 原文ファイルを翻訳しようとした／未 sync などの混乱に対応する。
 */
export async function showNeedSyncError(message: string): Promise<void> {
	const runSync = vscode.l10n.t("Run Sync");
	const docs = vscode.l10n.t("Open docs");
	const choice = await vscode.window.showErrorMessage(message, runSync, docs);
	if (choice === runSync) {
		await vscode.commands.executeCommand("mdait.sync");
	} else if (choice === docs) {
		await openDocs();
	}
}

/** AI（言語モデル）到達不能を示すエラーメッセージか */
function isAiUnavailableMessage(message: string): boolean {
	const m = message.toLowerCase();
	return (
		m.includes("language model is not available") ||
		m.includes("github copilot") ||
		m.includes("api usage limit") ||
		m.includes("permission is required")
	);
}

/**
 * 翻訳時エラーを表示する。AI 到達不能が疑われる場合は「診断」「ドキュメント」導線を付ける。
 */
export async function showTranslationError(error: unknown): Promise<void> {
	const message = error instanceof Error ? error.message : String(error);
	if (isAiUnavailableMessage(message)) {
		const diagnose = vscode.l10n.t("Diagnose");
		const docs = vscode.l10n.t("Open docs");
		const choice = await vscode.window.showErrorMessage(
			vscode.l10n.t("Error during translation: {0}", message),
			diagnose,
			docs,
		);
		if (choice === diagnose) {
			await vscode.commands.executeCommand("mdait.setup.diagnose");
		} else if (choice === docs) {
			await openDocs();
		}
		return;
	}
	vscode.window.showErrorMessage(
		vscode.l10n.t("Error during translation: {0}", message),
	);
}
