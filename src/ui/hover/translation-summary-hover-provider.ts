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
import { markdownParser } from "../../core/markdown/parser";
import { diffSourceLines, formatSourceDiff } from "../../core/markdown/source-diff";
import { findUnitAtLine } from "../../core/markdown/unit-locator";
import { UnitRegistryManager } from "../../core/unit-registry/unit-registry-manager";
import { Configuration } from "../../infra/config/configuration";
import { resolveMarkerIO } from "../../infra/config/marker-io";
import { FileExplorer } from "../../infra/workspace/file-explorer";
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
	public async provideHover(
		document: vscode.TextDocument,
		position: vscode.Position,
		token: vscode.CancellationToken,
	): Promise<vscode.Hover | null> {
		// Markdownファイル以外は対象外
		if (document.languageId !== "markdown") {
			return null;
		}

		const config = Configuration.getInstance();

		// マーカーを取得（external では行範囲からユニットを特定）
		let marker: MdaitMarker | null;
		if (config.isExternalMarkers()) {
			const explorer = new FileExplorer();
			const role = explorer.isSourceFile(document.uri.fsPath, config) ? "source" : "target";
			const io = resolveMarkerIO(config, document.uri.fsPath, role);
			const parsed = markdownParser.parse(document.getText(), config, io.provider, io.ctx);
			marker = findUnitAtLine(parsed.units, position.line)?.marker ?? null;
		} else {
			// コードブロック内の行ではマーカー判定を行わない
			const codeBlockLines = getCodeBlockLineSet(document.getText());
			if (codeBlockLines.has(position.line)) {
				return null;
			}
			// カーソル位置の行から mdait マーカーをパース
			marker = MdaitMarker.parse(document.lineAt(position.line).text);
		}
		if (!marker || !marker.hash) {
			return null;
		}

		// ユニットに紐づく note（registry に永続化・audit で AI へ渡す）を取得
		const note = await UnitRegistryManager.getInstance().loadNote(marker.hash);

		// サマリデータを取得
		const summary = this.summaryManager.getSummary(marker.hash);
		// 手で訳したが未確定のユニットは、サマリが無くても締めくくり方を説明する
		const unconfirmedEdit = !summary && marker.hasUnconfirmedEdit();
		// 原文が変わったユニットは「どこが変わったか」を出す（旧原文は unit-registry にある）
		const sourceDiff = marker.needsRevision() ? await this.buildSourceDiff(marker) : "";
		// サマリも note も未確定編集も差分も無ければ hover を出さない
		if (!summary && !note && !unconfirmedEdit && !sourceDiff) {
			return null;
		}

		// MarkdownStringを生成（needフラグ・note も考慮）
		const markdown = this.buildMarkdownString(summary, marker.need, note, unconfirmedEdit, sourceDiff);

		// Hoverオブジェクトを返す
		return new vscode.Hover(markdown);
	}

	/**
	 * 原文の新旧差分（```diff ブロック）を組み立てる。
	 *
	 * 旧原文は `need:revise@{旧原文ハッシュ}`、新原文は `from`（現在の原文ハッシュ）で
	 * `.mdait/unit-registry` から引く。どちらか引けなければ差分は出さない（AI は使わない）。
	 */
	private async buildSourceDiff(marker: MdaitMarker): Promise<string> {
		const oldHash = marker.getOldHashFromNeed();
		if (!oldHash || !marker.from) {
			return "";
		}
		try {
			const registry = UnitRegistryManager.getInstance();
			const [oldSource, newSource] = await Promise.all([
				registry.loadUnitRegistry(oldHash),
				registry.loadUnitRegistry(marker.from),
			]);
			if (oldSource === null || newSource === null) {
				return "";
			}
			return formatSourceDiff(diffSourceLines(oldSource, newSource));
		} catch {
			// 差分は補助情報。読めないことを理由に hover 自体を壊さない
			return "";
		}
	}

	/**
	 * サマリ情報からMarkdownStringを生成
	 * @param summary 翻訳サマリ情報
	 * @param needFlag ユニットのneedフラグ
	 * @returns MarkdownString
	 */
	private buildMarkdownString(
		summary: TranslationSummary | undefined,
		needFlag?: string | null,
		note?: string | null,
		unconfirmedEdit = false,
		sourceDiff = "",
	): vscode.MarkdownString {
		const md = new vscode.MarkdownString();
		md.isTrusted = true; // commandリンクを有効化
		md.supportHtml = true; // HTML埋め込みを有効化

		// 原文が変わったユニット: 何が変わったのかを先に出す（判断材料。ADR-260802-03）
		if (sourceDiff) {
			md.appendMarkdown(`### ${vscode.l10n.t("The source has changed")}\n\n`);
			md.appendMarkdown(`${sourceDiff}\n\n`);
			md.appendMarkdown(
				`${vscode.l10n.t(
					"Press “{0}” to translate it again, or fix it by hand and press “{1}”.",
					vscode.l10n.t("✨Translate"),
					vscode.l10n.t("Mark as Revised"),
				)}\n\n`,
			);
			return md;
		}

		// ヘッダー（need:reviewの場合は「要確認」と表示）
		if (unconfirmedEdit) {
			// 訳せたかどうかは機械には判定できないため、完了は人の宣言で決まる。
			// それを知らないと「訳したのに進捗が動かない」で手が止まる
			md.appendMarkdown(`### ✏️ ${vscode.l10n.t("Edited — not marked done yet")}\n\n`);
			md.appendMarkdown(
				`${vscode.l10n.t(
					"If you finished the translation by hand, press “{0}”.",
					needFlag?.startsWith("revise@") ? vscode.l10n.t("Mark as Revised") : vscode.l10n.t("Mark as Translated"),
				)}\n\n`,
			);
			return md;
		}
		if (needFlag === "review") {
			md.appendMarkdown(`### ${vscode.l10n.t("Needs Review")}\n\n`);
		} else {
			md.appendMarkdown(`### ✅ ${vscode.l10n.t("Translation Completed")}\n\n`);
		}

		// ユニット note（人間が残した意図的乖離の説明など。audit で AI に渡される）。
		// note は .mdait/unit-registry 由来の外部データなので、Markdown/コマンドリンクの
		// 注入を防ぐため appendText（エスケープ）で本文として描画する。
		if (note && note.trim() !== "") {
			md.appendMarkdown(`**📝 ${vscode.l10n.t("Note")}:**\n`);
			md.appendText(note);
			md.appendMarkdown("\n\n");
		}

		// サマリが無ければ（note のみの hover）ここで終了
		if (!summary) {
			return md;
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
