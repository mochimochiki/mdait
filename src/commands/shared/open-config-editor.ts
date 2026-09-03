/**
 * @file open-config-editor.ts
 * @description mdait.json を設定UI（custom editor）で開くための共通ヘルパー。
 * `showTextDocument` は custom editor を迂回して生JSONを開いてしまうため、
 * mdait.json を開く導線は必ずここを経由する（ADR: 設定UIを既定表示とする）。
 */

import * as vscode from "vscode";

/**
 * 設定UI（custom editor）の viewType。
 * package.json の `contributes.customEditors` および
 * `src/ui/settings/settings-panel.ts` の `SettingsPanel.viewType` と一致させること。
 * （commands 層から ui 層へ依存しないよう文字列で保持する）
 */
export const SETTINGS_EDITOR_VIEW_TYPE = "mdait.settingsEditor";

/**
 * mdait.json を設定UIで開く。
 * 設定UIの解決に失敗した場合のみ、生JSONへフォールバックする。
 */
export async function openConfigInSettingsEditor(configPath: string): Promise<void> {
	const uri = vscode.Uri.file(configPath);
	try {
		await vscode.commands.executeCommand("vscode.openWith", uri, SETTINGS_EDITOR_VIEW_TYPE);
	} catch (error) {
		console.log("mdait: Failed to open settings editor, falling back to JSON:", (error as Error).message);
		const document = await vscode.workspace.openTextDocument(uri);
		await vscode.window.showTextDocument(document);
	}
}
