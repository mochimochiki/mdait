/**
 * @file summary-decorator.ts
 * @description
 *   翻訳サマリの概要をマーカー行の末尾に薄く表示するDecorator。
 *   GitLensのようにインラインで簡潔なサマリを表示し、ホバーで詳細を確認できるようにする。
 * @module ui/hover/summary-decorator
 */
import * as vscode from "vscode";
import { MdaitMarker } from "../../core/markdown/mdait-marker";
import type { SummaryManager } from "./summary-manager";

/**
 * 翻訳サマリをインライン表示するDecoratorクラス
 */
export class SummaryDecorator {
	private decorationType: vscode.TextEditorDecorationType;
	private summaryManager: SummaryManager;

	/**
	 * Constructor
	 * @param summaryManager サマリマネージャーインスタンス
	 */
	constructor(summaryManager: SummaryManager) {
		this.summaryManager = summaryManager;

		// Decorationスタイルを定義（GitLensライクな薄いグレー表示）
		this.decorationType = vscode.window.createTextEditorDecorationType({
			after: {
				color: new vscode.ThemeColor("editorCodeLens.foreground"), // CodeLensと同じ色
				margin: "0 0 0 1em",
				fontStyle: "italic",
			},
		});
	}

	/**
	 * アクティブエディタのDecorationを更新
	 */
	public refresh(): void {
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.document.languageId !== "markdown") {
			return;
		}

		this.updateDecorations(editor);
	}

	/**
	 * 特定のエディタのDecorationを更新
	 * @param editor 対象エディタ
	 */
	public updateDecorations(editor: vscode.TextEditor): void {
		const document = editor.document;
		const decorations: vscode.DecorationOptions[] = [];

		// 各行をスキャンしてmdaitマーカーを検出
		for (let lineIndex = 0; lineIndex < document.lineCount; lineIndex++) {
			const line = document.lineAt(lineIndex);
			const marker = MdaitMarker.parse(line.text);

			if (!marker?.hash) {
				continue;
			}

			// サマリデータを取得
			const summary = this.summaryManager.getSummary(marker.hash);
			if (!summary) {
				continue;
			}

			// サマリの概要テキストを生成（needフラグも考慮）
			const summaryText = this.buildSummaryText(summary.stats.duration, summary.stats.tokens, marker.need);

			// Decorationを追加
			const range = new vscode.Range(lineIndex, line.text.length, lineIndex, line.text.length);
			decorations.push({
				range,
				renderOptions: {
					after: {
						contentText: summaryText,
					},
				},
			});
		}

		// Decorationを適用
		editor.setDecorations(this.decorationType, decorations);
	}

	/**
	 * サマリの概要テキストを生成
	 * @param duration 処理時間（秒）
	 * @param tokens トークン数（オプション）
	 * @param needFlag needフラグ
	 * @returns 概要テキスト
	 */
	private buildSummaryText(duration: number, tokens?: number, needFlag?: string | null): string {
		// need:reviewの場合は「要レビュー」を表示
		const status = needFlag === "review" 
			? vscode.l10n.t("Needs Review") 
			: vscode.l10n.t("Translation completed");
		const parts: string[] = [`${status} :`];

		// 処理時間
		parts.push(`${duration.toFixed(1)}${vscode.l10n.t("seconds")}`);

		// トークン数（あれば）
		if (tokens) {
			parts.push(`${tokens.toLocaleString()} ${vscode.l10n.t("Tokens")}`);
		}

		return parts.join(" ");
	}

	/**
	 * Decorationをクリア
	 */
	public clear(): void {
		const editor = vscode.window.activeTextEditor;
		if (editor) {
			editor.setDecorations(this.decorationType, []);
		}
	}

	/**
	 * Dispose
	 */
	public dispose(): void {
		this.decorationType.dispose();
	}
}
