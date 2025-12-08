import * as vscode from "vscode";

/**
 * エディタが開かれるまで待機する最大時間（ミリ秒）
 */
const EDITOR_OPEN_TIMEOUT_MS = 3000;

/**
 * エディタチェックの間隔（ミリ秒）
 */
const EDITOR_CHECK_INTERVAL_MS = 100;

/**
 * settings.jsonにコメント付き雛形を作成して開くコマンド
 */
export async function createSettingsCommand(): Promise<void> {
	try {
		// ワークスペースが開かれているか確認
		if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
			vscode.window.showErrorMessage(vscode.l10n.t("No workspace folder is open."));
			return;
		}

		// settings.json（JSON形式）を開く
		await vscode.commands.executeCommand("workbench.action.openSettingsJson");

		// settings.jsonが開かれるまで待機
		const editor = await waitForSettingsEditor();
		if (!editor) {
			vscode.window.showWarningMessage(
				vscode.l10n.t("Could not open settings.json. Please manually add mdait configuration."),
			);
			return;
		}

		// テンプレートを準備
		const template = `	// mdait configuration
	"mdait.transPairs": [
		{
			// Source language directory (relative to workspace root)
			"sourceDir": "docs/ja",
			// Target language directory (relative to workspace root)
			"targetDir": "docs/en",
			// Source language code (e.g., "ja", "en", "zh")
			"sourceLang": "ja",
			// Target language code
			"targetLang": "en"
		}
	],
	// AI provider: "default" (uses GitHub Copilot), "ollama", or "vscode-lm"
	"mdait.ai.provider": "default",
	// AI model name (for default provider, e.g., "gpt-4o", "gpt-4o-mini")
	"mdait.ai.model": "gpt-4o"`;

		const document = editor.document;
		const text = document.getText();

		// 既にmdait設定がある場合は何もしない
		if (text.includes("mdait.transPairs")) {
			vscode.window.showInformationMessage(
				vscode.l10n.t("mdait configuration already exists in settings.json."),
			);
			return;
		}

		// settings.jsonの内容を解析して適切な位置に挿入
		await editor.edit((editBuilder) => {
			if (text.trim() === "" || text.trim() === "{}") {
				// 空の場合は新規作成
				editBuilder.replace(new vscode.Range(0, 0, document.lineCount, 0), `{\n${template}\n}\n`);
			} else {
				// 既存の設定がある場合は最後の}の前に挿入
				const lastBraceIndex = text.lastIndexOf("}");
				if (lastBraceIndex !== -1) {
					// 最後の設定項目の後にカンマを追加する必要があるかチェック
					const beforeBrace = text.substring(0, lastBraceIndex).trim();
					const needsComma = beforeBrace.length > 1 && !beforeBrace.endsWith(",");
					const insertion = `${needsComma ? ",\n" : "\n"}${template}\n`;
					const position = document.positionAt(lastBraceIndex);
					editBuilder.insert(position, insertion);
				}
			}
		});

		vscode.window.showInformationMessage(
			vscode.l10n.t(
				"mdait configuration template has been added to settings.json. Please update the values according to your project.",
			),
		);
	} catch (error) {
		vscode.window.showErrorMessage(vscode.l10n.t("Failed to create settings: {0}", (error as Error).message));
	}
}

/**
 * settings.jsonエディタが開かれるまで待機する
 * @returns settings.jsonのエディタ、またはタイムアウト時はundefined
 */
async function waitForSettingsEditor(): Promise<vscode.TextEditor | undefined> {
	const startTime = Date.now();

	while (Date.now() - startTime < EDITOR_OPEN_TIMEOUT_MS) {
		const editor = vscode.window.activeTextEditor;
		if (editor?.document.fileName.endsWith("settings.json")) {
			return editor;
		}
		// 短い間隔で再チェック
		await new Promise((resolve) => setTimeout(resolve, EDITOR_CHECK_INTERVAL_MS));
	}

	return undefined;
}
