/**
 * @file summary-decorator.ts
 * @description
 *   翻訳サマリの概要をマーカー行の末尾に薄く表示するDecorator。
 *   GitLensのようにインラインで簡潔なサマリを表示し、ホバーで詳細を確認できるようにする。
 * @module ui/hover/summary-decorator
 */
import * as vscode from "vscode";
import { getCodeBlockLineSet } from "../../core/markdown/code-block-lines";
import { MdaitMarker } from "../../core/markdown/mdait-marker";
import { markdownParser } from "../../core/markdown/parser";
import { Configuration } from "../../infra/config/configuration";
import { resolveMarkerIO } from "../../infra/config/marker-io";
import { FileExplorer } from "../../infra/workspace/file-explorer";
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
		const config = Configuration.getInstance();

		const addDecoration = (lineIndex: number, marker: MdaitMarker): void => {
			const summary = this.summaryManager.getSummary(marker.hash);
			// AI 翻訳のサマリが無くても、手で訳して未確定のユニットには状態を出す。
			// 訳文を書いただけでは need は落ちないため、書いた本人に「まだ残っている」
			// ことが見えないと進捗が動かない理由が分からない（詳細は hover 側）
			const summaryText = summary
				? this.buildSummaryText(summary.stats.duration, summary.stats.tokens, marker.need)
				: marker.hasUnconfirmedEdit()
					? vscode.l10n.t("Edited — not marked done yet")
					: undefined;
			if (!summaryText) {
				return;
			}
			const lineLength = document.lineAt(lineIndex).text.length;
			decorations.push({
				range: new vscode.Range(lineIndex, lineLength, lineIndex, lineLength),
				renderOptions: { after: { contentText: summaryText } },
			});
		};

		if (config.isExternalMarkers()) {
			// external: 本文にマーカーが無いため、パースしてユニット開始行に装飾を置く
			const explorer = new FileExplorer();
			const role = explorer.isSourceFile(document.uri.fsPath, config) ? "source" : "target";
			const io = resolveMarkerIO(config, document.uri.fsPath, role);
			const parsed = markdownParser.parse(document.getText(), config, io.provider, io.ctx);
			for (const unit of parsed.units) {
				if (unit.marker?.hash) {
					addDecoration(unit.startLine, unit.marker);
				}
			}
			editor.setDecorations(this.decorationType, decorations);
			return;
		}

		// コードブロック内の行はマーカー検出対象外
		const codeBlockLines = getCodeBlockLineSet(document.getText());

		// 各行をスキャンしてmdaitマーカーを検出
		for (let lineIndex = 0; lineIndex < document.lineCount; lineIndex++) {
			if (codeBlockLines.has(lineIndex)) {
				continue;
			}
			const line = document.lineAt(lineIndex);
			const marker = MdaitMarker.parse(line.text);

			if (!marker?.hash) {
				continue;
			}

			addDecoration(lineIndex, marker);
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
