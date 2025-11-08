/**
 * @file translation-summary-hover-provider.ts
 * @description
 *   mdaitマーカー行にマウスホバーしたときに翻訳サマリを表示するHoverProvider。
 *   翻訳実行後の統計・用語候補・注意事項などをリッチなMarkdown形式で表示する。
 * @module ui/hover/translation-summary-hover-provider
 */
import * as vscode from "vscode";
import { MdaitMarker } from "../../core/markdown/mdait-marker";
import type { SummaryManager, TranslationSummary } from "./summary-manager";

/**
 * 翻訳サマリを表示するHoverProvider
 */
export class TranslationSummaryHoverProvider implements vscode.HoverProvider {
	private summaryManager: SummaryManager;

	/**
	 * Constructor
	 * @param summaryManager サマリマネージャーインスタンス
	 */
	constructor(summaryManager: SummaryManager) {
		this.summaryManager = summaryManager;
	}

	/**
	 * Hoverを提供する
	 * @param document 対象ドキュメント
	 * @param position マウスカーソル位置
	 * @param token キャンセレーショントークン
	 * @returns Hoverオブジェクト（サマリが存在しない場合はnull）
	 */
	public provideHover(
		document: vscode.TextDocument,
		position: vscode.Position,
		token: vscode.CancellationToken,
	): vscode.ProviderResult<vscode.Hover> {
		// Markdownファイル以外は対象外
		if (document.languageId !== "markdown") {
			return null;
		}

		// カーソル位置の行を取得
		const line = document.lineAt(position.line);

		// mdaitマーカーをパース
		const marker = MdaitMarker.parse(line.text);
		if (!marker || !marker.hash) {
			return null;
		}

		// サマリデータを取得
		const summary = this.summaryManager.getSummary(marker.hash);
		if (!summary) {
			return null;
		}

		// MarkdownStringを生成
		const markdown = this.buildMarkdownString(summary);

		// Hoverオブジェクトを返す
		return new vscode.Hover(markdown);
	}

	/**
	 * サマリ情報からMarkdownStringを生成
	 * @param summary 翻訳サマリ情報
	 * @returns MarkdownString
	 */
	private buildMarkdownString(summary: TranslationSummary): vscode.MarkdownString {
		const md = new vscode.MarkdownString();
		md.isTrusted = true; // commandリンクを有効化
		md.supportHtml = true; // HTML埋め込みを有効化

		// ヘッダー
		md.appendMarkdown(`### 📊 ${vscode.l10n.t("Translation Completed")}\n\n`);

		// 統計情報
		md.appendMarkdown(`**${vscode.l10n.t("Statistics")}:**\n`);
		md.appendMarkdown(
			`- ${vscode.l10n.t("Duration")}: ${summary.stats.duration.toFixed(1)}${vscode.l10n.t("seconds")}\n`,
		);
		if (summary.stats.tokens) {
			md.appendMarkdown(`- ${vscode.l10n.t("Tokens")}: ${summary.stats.tokens.toLocaleString()}\n`);
		}
		md.appendMarkdown("\n");

		// 用語候補
		if (summary.termCandidates && summary.termCandidates.length > 0) {
			md.appendMarkdown(`**💡 ${vscode.l10n.t("Term Candidates")}:**\n`);
			for (const candidate of summary.termCandidates) {
				const args = encodeURIComponent(JSON.stringify({ term: candidate.term, context: candidate.context }));
				const commandUri = `command:mdait.addToGlossary?${args}`;
				md.appendMarkdown(`- "${candidate.term}" → [${vscode.l10n.t("Add to glossary")}](${commandUri})\n`);
			}
			md.appendMarkdown("\n");
		}

		// 注意事項
		if (summary.warnings && summary.warnings.length > 0) {
			md.appendMarkdown(`**⚠️ ${vscode.l10n.t("Warnings")}:**\n`);
			for (const warning of summary.warnings) {
				md.appendMarkdown(`- ${warning}\n`);
			}
		}

		return md;
	}
}
