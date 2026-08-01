/**
 * @file guidance.ts
 * @description エラー時に「次に何をすればよいか」をその場で示すための共通導線ヘルパー（次善策）。
 * showErrorMessage 等にアクションボタンを付与し、診断・Sync・ドキュメントへ誘導する。
 */

import * as fs from "node:fs";
import * as vscode from "vscode";
import { Configuration } from "../../infra/config/configuration";
import { openConfigInSettingsEditor } from "./open-config-editor";

const TROUBLESHOOTING_URL =
	"https://github.com/mochimochiki/mdait/blob/main/docs/guide/ja/troubleshooting.md";

/** 設定ファイルを設定UIで開く（無ければ作成コマンドへ） */
async function openConfigFile(): Promise<void> {
	const configPath = Configuration.getInstance().getConfigFilePath();
	if (configPath && fs.existsSync(configPath)) {
		await openConfigInSettingsEditor(configPath);
		return;
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

/**
 * ディレクトリ翻訳の失敗を、理由と次の一手つきで表示する。
 *
 * 件数だけの「0 成功 / 5 失敗」では、AI に届いていないのか原稿の問題なのかが
 * 分からず、ログファイルを開けない利用者はそこで手が止まる。最初の失敗理由を
 * 本文に出し、AI 到達不能が疑われるときは診断・設定・ドキュメントへ導く。
 *
 * @param successful 成功ファイル数
 * @param failed 失敗ファイル数
 * @param firstError 最初に発生したエラー（無ければ理由なしの警告になる）
 */
export async function showDirectoryTranslationFailure(
	successful: number,
	failed: number,
	firstError?: unknown,
): Promise<void> {
	const reason =
		firstError instanceof Error
			? firstError.message
			: firstError !== undefined
				? String(firstError)
				: "";

	if (!reason) {
		vscode.window.showWarningMessage(
			vscode.l10n.t(
				"Directory translation completed: {0} files succeeded, {1} files failed",
				successful,
				failed,
			),
		);
		return;
	}

	const body = vscode.l10n.t(
		"Directory translation completed: {0} files succeeded, {1} files failed. Reason: {2}",
		successful,
		failed,
		reason,
	);

	if (!isAiUnavailableMessage(reason)) {
		vscode.window.showWarningMessage(body);
		return;
	}

	const diagnose = vscode.l10n.t("Diagnose");
	const openConfig = vscode.l10n.t("Open mdait.json");
	const docs = vscode.l10n.t("Open docs");
	const choice = await vscode.window.showErrorMessage(
		body,
		diagnose,
		openConfig,
		docs,
	);
	if (choice === diagnose) {
		await vscode.commands.executeCommand("mdait.setup.diagnose");
	} else if (choice === openConfig) {
		await openConfigFile();
	} else if (choice === docs) {
		await openDocs();
	}
}
