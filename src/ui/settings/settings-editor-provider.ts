/**
 * mdait.json をエディタで開いたときに、標準JSONエディタではなく
 * 設定UI（SettingsPanel）をデフォルト表示にするための CustomTextEditorProvider。
 * package.json の customEditors（priority: "default"）と対になる。
 */
import * as vscode from "vscode";
import { Configuration } from "../../infra/config/configuration";
import { SettingsPanel } from "./settings-panel";

export class SettingsEditorProvider implements vscode.CustomTextEditorProvider {
	constructor(private readonly extensionUri: vscode.Uri) {}

	public resolveCustomTextEditor(_document: vscode.TextDocument, webviewPanel: vscode.WebviewPanel): void {
		webviewPanel.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "assets")],
		};
		SettingsPanel.bind(webviewPanel, this.extensionUri);
	}
}

/**
 * 現在アクティブなタブのURIを取得する。
 * 設定UI（カスタムエディタ）は `activeTextEditor` に現れないため、
 * コマンドパレット実行時はタブ情報から取得する必要がある
 */
function getActiveEditorUri(): vscode.Uri | undefined {
	const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
	if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom) {
		return input.uri;
	}
	return vscode.window.activeTextEditor?.document.uri;
}

/** editor/title の切り替えボタン: 設定UI → mdait.json のソース(JSON)表示 */
export function openSettingsAsJsonCommand(uri?: vscode.Uri): void {
	const target = uri ?? getActiveEditorUri();
	if (target) {
		vscode.commands.executeCommand("vscode.openWith", target, "default");
	}
}

/**
 * editor/title の切り替えボタン: mdait.json のソース(JSON)表示 → 設定UI。
 * `resourceFilename == mdait.json` の when 条件は `.mdait/` 外の同名ファイルにも
 * マッチしうるが、SettingsPanel は常に `Configuration.getConfigFilePath()` の
 * 本物の mdait.json を読み書きするため、別ファイル上での実行を本物へ書き換える
 * 導線にしてはならない。実際の設定ファイルを開いている場合のみタブ内切り替えし、
 * それ以外は SettingsPanel.open() で正しい mdait.json を開き直す
 */
export function openSettingsAsUiCommand(uri?: vscode.Uri): void {
	const target = uri ?? getActiveEditorUri();
	const configPath = Configuration.getInstance().getConfigFilePath();
	if (target && configPath && target.fsPath === configPath) {
		vscode.commands.executeCommand("vscode.openWith", target, SettingsPanel.viewType);
		return;
	}
	SettingsPanel.open();
}
