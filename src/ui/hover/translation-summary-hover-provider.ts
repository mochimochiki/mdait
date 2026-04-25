/**
 * @file translation-summary-hover-provider.ts
 * @description
 *   mdaitマーカー行にマウスホバーしたときに翻訳サマリを表示するHoverProvider。
 *   翻訳実行後の統計・用語候補・注意事項などをリッチなMarkdown形式で表示する。
 * @module ui/hover/translation-summary-hover-provider
 */
import * as vscode from "vscode";
import { getCodeBlockLineSet } from "../../core/markdown/code-block-lines";
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

		// コードブロック内の行ではマーカー判定を行わない
		const codeBlockLines = getCodeBlockLineSet(document.getText());
		if (codeBlockLines.has(position.line)) {
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

		// MarkdownStringを生成（needフラグも考慮）
		const markdown = this.buildMarkdownString(summary, marker.need);

		// Hoverオブジェクトを返す
		return new vscode.Hover(markdown);
	}

	/**
	 * サマリ情報からMarkdownStringを生成
	 * @param summary 翻訳サマリ情報
	 * @param needFlag ユニットのneedフラグ
	 * @returns MarkdownString
	 */
	private buildMarkdownString(summary: TranslationSummary, needFlag?: string | null): vscode.MarkdownString {
		const md = new vscode.MarkdownString();
		md.isTrusted = true; // commandリンクを有効化
		md.supportHtml = true; // HTML埋め込みを有効化

		// ヘッダー（need:reviewの場合は「要確認」と表示）
		if (needFlag === "review") {
			md.appendMarkdown(`### ${vscode.l10n.t("Needs Review")}\n\n`);
		} else {
			md.appendMarkdown(`### ✅ ${vscode.l10n.t("Translation Completed")}\n\n`);
		}

		// 統計情報
		md.appendMarkdown(`**${vscode.l10n.t("Statistics")}:**\n`);
		md.appendMarkdown(
			`- ${vscode.l10n.t("Duration")}: ${summary.stats.duration.toFixed(1)}${vscode.l10n.t("seconds")}\n`,
		);
		if (summary.stats.tokens) {
			md.appendMarkdown(`- ${vscode.l10n.t("Tokens")}: ${summary.stats.tokens.toLocaleString()}\n`);
		}
		md.appendMarkdown("\n");

		// 警告
		if (summary.warnings && summary.warnings.length > 0) {
			md.appendMarkdown(`**⚠️ ${vscode.l10n.t("Warnings")}:**\n`);
			for (const warning of summary.warnings) {
				md.appendMarkdown(`- ${warning}\n`);
			}
		}

		// レビュー推奨理由
		if (summary.reviewReasons && summary.reviewReasons.length > 0) {
			md.appendMarkdown(`**🔍 ${vscode.l10n.t("Review Reasons")}:**\n`);
			for (const reason of summary.reviewReasons) {
				md.appendMarkdown(`- ${reason}\n`);
			}
			md.appendMarkdown("\n");
		}

		// TM参照
		if (summary.tmReferences && summary.tmReferences.length > 0) {
			md.appendMarkdown(`**📚 ${vscode.l10n.t("TM References")}:**\n`);
			for (const ref of summary.tmReferences) {
				md.appendMarkdown(`- ${ref.source}\n`);
				md.appendMarkdown(`  →${ref.target}\n`);
			}
			md.appendMarkdown("\n");
		}

		// 適用された用語
		if (summary.appliedTerms && summary.appliedTerms.length > 0) {
			md.appendMarkdown(`**📓 ${vscode.l10n.t("Applied Terms")}:**\n`);
			for (const term of summary.appliedTerms) {
				md.appendMarkdown(`- ${term.source} → ${term.target}\n`);
			}
			md.appendMarkdown("\n");
		}

		// 用語追加候補
		if (summary.termCandidates && summary.termCandidates.length > 0) {
			md.appendMarkdown(`**💡 ${vscode.l10n.t("Term Candidates")}:**\n`);
			for (const candidate of summary.termCandidates) {
				const args = encodeURIComponent(
					JSON.stringify({
						source: candidate.source,
						target: candidate.target,
						context: candidate.context,
						sourceLang: candidate.sourceLang,
						targetLang: candidate.targetLang,
					}),
				);
				const commandUri = `command:mdait.addToGlossary?${args}`;
				const displayText = candidate.target ? `${candidate.source} → ${candidate.target}` : candidate.source;
				md.appendMarkdown(`- ${displayText} [${vscode.l10n.t("Add to glossary")}](${commandUri})\n`);
			}
			md.appendMarkdown("\n");
		}

		return md;
	}
}
