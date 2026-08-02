/**
 * @file guidance.ts
 * @description エラー時に「次に何をすればよいか」をその場で示すための共通導線ヘルパー（次善策）。
 * showErrorMessage 等にアクションボタンを付与し、診断・Sync・ドキュメントへ誘導する。
 */

import * as fs from "node:fs";
import * as vscode from "vscode";
import type { PatchFailureReason } from "../../core/diff/diff-generator";
import { Configuration } from "../../infra/config/configuration";
import { isOperationCancelled } from "../../infra/errors/operation-cancelled";
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
 * 中断（ユーザーが止めた）は失敗ではないため、エラーとしては出さない。
 */
export async function showTranslationError(error: unknown): Promise<void> {
	if (isOperationCancelled(error)) {
		vscode.window.showInformationMessage(vscode.l10n.t("Translation cancelled."));
		return;
	}
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

/** パッチ適用が失敗した理由を、原稿を書く人に伝わる言葉にする */
export function describePatchFailure(reason: PatchFailureReason): string {
	switch (reason) {
		case "empty-patch":
			return vscode.l10n.t("the AI returned no changes");
		case "unrecognized-format":
			return vscode.l10n.t("the AI did not return the expected diff format");
		case "no-changes":
			return vscode.l10n.t("the returned diff contained no additions or deletions");
		default:
			return vscode.l10n.t(
				"the surrounding lines used to locate the change were not found in the translation (it may have been edited by hand)",
			);
	}
}

/** 翻訳結果のうち、通知に必要な部分だけの形 */
export interface TransOutcomeSummary {
	outcome:
		| "completed"
		| "nothing-to-do"
		| "cancelled"
		| "no-trans-pair"
		| "busy"
		| "failed";
	translatedCount: number;
	patchFailures: Array<{ title?: string; reason: PatchFailureReason }>;
	writeFailures: Array<{ title?: string; reason?: string }>;
}

/** 通知から呼び出せる次の一手 */
export interface TransOutcomeActions {
	/** 対象の呼び名（ファイル名・ユニット名） */
	label: string;
	/** パッチを使わず全文で訳し直す */
	retryFullTranslation?: () => Promise<unknown>;
}

/**
 * 翻訳の終わり方を1回だけ通知する。
 *
 * **必ず排他区間の外から呼ぶこと。** ここはボタン付き通知を await するため、
 * ロックを握ったまま呼ぶと解放されなくなる。
 *
 * 「押したのに何も起きない」を無くすため、何もしなかった場合も黙らない。
 * 逆に、結果を見ずに成功を出すこともしない（以前は CodeLens が常に
 * 「翻訳が完了しました」を出しており、エラーと成功が並んで表示されていた）。
 */
export async function reportTransOutcome(
	result: TransOutcomeSummary,
	actions: TransOutcomeActions,
): Promise<void> {
	if (result.outcome === "failed") {
		// 失敗の理由は showTranslationError が既に伝えている（ここで重ねない）
		return;
	}

	if (result.outcome === "no-trans-pair") {
		await showNeedSyncError(
			vscode.l10n.t("No translation pair found for: {0}", actions.label),
		);
		return;
	}

	if (result.outcome === "busy") {
		vscode.window.showInformationMessage(
			vscode.l10n.t(
				"{0} is already being translated. Wait for it to finish, or cancel it first.",
				actions.label,
			),
		);
		return;
	}

	if (result.outcome === "cancelled") {
		vscode.window.showInformationMessage(
			result.translatedCount > 0
				? vscode.l10n.t(
						"Translation cancelled for {0}. {1} unit(s) translated before stopping were kept.",
						actions.label,
						result.translatedCount,
					)
				: vscode.l10n.t("Translation cancelled for {0}.", actions.label),
		);
		return;
	}

	if (result.outcome === "nothing-to-do") {
		vscode.window.showInformationMessage(
			vscode.l10n.t("Nothing to translate in {0}.", actions.label),
		);
		return;
	}

	// 書き戻せなかったユニットは翻訳結果が失われている。最優先で伝える
	if (result.writeFailures.length > 0) {
		const runSync = vscode.l10n.t("Run Sync");
		const choice = await vscode.window.showWarningMessage(
			vscode.l10n.t(
				"Could not write back {0} translated unit(s) in {1} because their markers were not found (the file may have changed). Run Sync and translate again.",
				result.writeFailures.length,
				actions.label,
			),
			runSync,
		);
		if (choice === runSync) {
			await vscode.commands.executeCommand("mdait.sync");
		}
		return;
	}

	// パッチ適用に失敗したユニットは訳文を据え置いてある。理由を出したうえで、
	// 全文で訳し直すかどうかを一度だけ尋ねる（ユニットごとに聞くと連打になる）
	if (result.patchFailures.length > 0) {
		const reason = describePatchFailure(result.patchFailures[0].reason);
		const body = vscode.l10n.t(
			"Kept the existing translation for {0} unit(s) in {1}: patch could not be applied because {2}. Re-translating in full may overwrite manual edits.",
			result.patchFailures.length,
			actions.label,
			reason,
		);
		if (!actions.retryFullTranslation) {
			vscode.window.showWarningMessage(body);
			return;
		}
		const retry = vscode.l10n.t("Re-translate in full");
		const choice = await vscode.window.showWarningMessage(body, retry);
		if (choice === retry) {
			await actions.retryFullTranslation();
		}
		return;
	}

	vscode.window.showInformationMessage(
		vscode.l10n.t(
			"Translation completed for {0}: {1} unit(s).",
			actions.label,
			result.translatedCount,
		),
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
