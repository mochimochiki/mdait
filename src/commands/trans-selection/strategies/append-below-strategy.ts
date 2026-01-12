/**
 * @file append-below-strategy.ts
 * @description 選択範囲の下に1行空白を開けて翻訳結果を追記する戦略
 */

import * as vscode from "vscode";
import type { OutputStrategy, TranslationOutput } from "../output-strategy";

/**
 * 選択範囲の下に翻訳結果を追記する出力戦略
 * 選択範囲の最終行の次の行に空白行を挿入し、その下に翻訳結果を追記
 */
export class AppendBelowStrategy implements OutputStrategy {
	public readonly name = "append-below";

	/**
	 * 翻訳結果を選択範囲の下に追記
	 * @param output 翻訳結果データ
	 * @param editor エディタインスタンス
	 */
	public async apply(output: TranslationOutput, editor: vscode.TextEditor): Promise<void> {
		const selection = editor.selection;
		const endLine = selection.end.line;

		// 選択範囲の最終行の次の行の先頭に挿入位置を設定
		const insertPosition = new vscode.Position(endLine + 1, 0);

		await editor.edit((editBuilder) => {
			// 空白行 + 翻訳結果を挿入
			editBuilder.insert(insertPosition, `\n${output.translatedText}\n`);
		});
	}
}
