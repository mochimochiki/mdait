/**
 * @file codelens-command.ts
 * @description
 *   CodeLensから呼び出される翻訳コマンドを提供するモジュール。
 *   - エディタ上の特定位置（Range）から該当ユニットを特定し、既存の翻訳機能を呼び出す
 *   - 既存のtransUnitCommandとの連携により、コア機能を再利用する
 * @module ui/codelens/codelens-command
 */
import * as vscode from "vscode";
import { transUnitCommand } from "../../commands/trans/trans-command";
import { MdaitMarker } from "../../core/markdown/mdait-marker";

/**
 * CodeLensから翻訳を実行するコマンド
 * @param range CodeLensが表示されている行の範囲
 */
export async function codeLensTranslateCommand(range: vscode.Range): Promise<void> {
	try {
		// アクティブなエディタを取得
		const activeEditor = vscode.window.activeTextEditor;
		if (!activeEditor) {
			vscode.window.showErrorMessage(vscode.l10n.t("No active editor found."));
			return;
		}

		const document = activeEditor.document;
		const targetPath = document.uri.fsPath;

		// 指定された行のテキストを取得
		const lineText = document.lineAt(range.start.line).text;

		// マーカーからunitHashを抽出
		const marker = MdaitMarker.parse(lineText);
		const unitHash = marker?.hash;
		if (!unitHash) {
			vscode.window.showErrorMessage(vscode.l10n.t("Could not extract unit hash from marker."));
			return;
		}

		// 既存のtransUnitCommandを呼び出し
		await transUnitCommand(targetPath, unitHash);

		vscode.window.showInformationMessage(vscode.l10n.t("Translation completed for unit: {0}", unitHash));
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		vscode.window.showErrorMessage(vscode.l10n.t("Translation failed: {0}", errorMessage));
	}
}
