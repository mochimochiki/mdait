/**
 * mdait.json をエディタで開いたときに、標準JSONエディタではなく
 * 設定UI（SettingsPanel）をデフォルト表示にするための CustomTextEditorProvider。
 * package.json の customEditors（priority: "default"）と対になる。
 */
import * as vscode from "vscode";
import { SettingsPanel } from "./settings-panel";

export class SettingsEditorProvider implements vscode.CustomTextEditorProvider {
	constructor(private readonly extensionUri: vscode.Uri) {}

	public resolveCustomTextEditor(
		_document: vscode.TextDocument,
		webviewPanel: vscode.WebviewPanel,
	): void {
		webviewPanel.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "assets")],
		};
		SettingsPanel.bind(webviewPanel, this.extensionUri);
	}
}

/** editor/title の切り替えボタン: 設定UI → mdait.json のソース(JSON)表示 */
export function openSettingsAsJsonCommand(uri?: vscode.Uri): void {
	const target = uri ?? vscode.window.activeTextEditor?.document.uri;
	if (target) {
		vscode.commands.executeCommand("vscode.openWith", target, "default");
	}
}

/** editor/title の切り替えボタン: mdait.json のソース(JSON)表示 → 設定UI */
export function openSettingsAsUiCommand(uri?: vscode.Uri): void {
	const target = uri ?? vscode.window.activeTextEditor?.document.uri;
	if (target) {
		vscode.commands.executeCommand(
			"vscode.openWith",
			target,
			SettingsPanel.viewType,
		);
	}
}
