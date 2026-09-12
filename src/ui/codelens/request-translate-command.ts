/**
 * @file request-translate-command.ts
 * @description
 *   CodeLens の「翻訳待ちに戻す」（need:review → need:translate）を受けるコマンド。
 *   押した行からユニットを特定し、書き換えは `getFileHandler().requestTranslate` に委ねる
 *   （サーフェス側でマーカーを書き換えない。理由は commands/markers/unit-mutation.ts）。
 *   印を付け替えるだけで AI は呼ばない。訳すのはその後の「✨翻訳」に任せる。
 * @module ui/codelens/request-translate-command
 */
import * as vscode from "vscode";
import { getFileHandler } from "../../commands/file-handler/file-handler-factory";
import type { NeedTarget } from "../../commands/markers/resolve-need";
import type { RequestTranslateResult } from "../../commands/markers/request-translate";
import { getMarkerAtLine } from "./codelens-command";

/** スキップの理由を人間可読なメッセージに変換する */
function describeRequestTranslateFailure(reason: RequestTranslateResult["reason"]): string {
	if (reason === "not-review") {
		return vscode.l10n.t("This unit is not awaiting review (need:review). Nothing was changed.");
	}
	return vscode.l10n.t("Could not find a unit at this position.");
}

/**
 * 押した行から書き換えの対象を決める。
 * - Markdown: その行のマーカー（external ではその行を含むユニット）の hash
 * - 非Markdown: ファイル＝1ユニットなので、行に関わらずファイル全体
 *
 * 見つからなければ null（呼び出し側が警告を出す）。
 */
function resolveTargetAtLine(document: vscode.TextDocument, line: number): NeedTarget | null {
	if (document.languageId !== "markdown") {
		return { kind: "file" };
	}
	const marker = getMarkerAtLine(document, line);
	return marker?.hash ? { kind: "unit", hash: marker.hash } : null;
}

/**
 * CodeLens から「翻訳待ちに戻す」を実行するコマンド。
 *
 * 成功時は何も出さない。need 解除（`codeLensClearNeedCommand`）と同じ流儀で、CodeLens の
 * ラベルが「✨翻訳」へ変わること自体が結果の表示になる（変化の気づきはステータスバーの
 * 常駐サマリが受け持つ。ux.md §3.3）。スキップだけ警告を1行出す。
 *
 * @param range CodeLens が表示されている行の範囲
 */
export async function codeLensRequestTranslateCommand(range: vscode.Range): Promise<void> {
	try {
		const activeEditor = vscode.window.activeTextEditor;
		if (!activeEditor) {
			vscode.window.showErrorMessage(vscode.l10n.t("No active editor found."));
			return;
		}

		const document = activeEditor.document;
		const target = resolveTargetAtLine(document, range.start.line);
		if (!target) {
			vscode.window.showWarningMessage(vscode.l10n.t("Could not find a unit at this position."));
			return;
		}

		const filePath = document.uri.fsPath;
		const result = await getFileHandler(filePath).requestTranslate(filePath, target);
		if (!result.requested) {
			vscode.window.showWarningMessage(describeRequestTranslateFailure(result.reason));
		}
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		vscode.window.showErrorMessage(vscode.l10n.t("Failed to mark unit as needing translation: {0}", errorMessage));
	}
}
