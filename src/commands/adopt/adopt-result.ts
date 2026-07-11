/**
 * @file adopt-result.ts
 * @description
 *   AI同期（合成コマンド）の結果型とレポート/nextActions 生成の純関数。
 *   VS Code API 非依存（単体テストの中心）。合成側は新しいマーカー変異を
 *   導入せず、各段（sync(adopt)+align / AIペアリング検証）の結果を集計するだけ。
 * @module commands/adopt/adopt-result
 */

import type { SyncResult } from "../sync/sync-command";
import { generateReviewTableSection } from "../ai-review/review-table";
import { type AiReviewFileResult, type ReviewAggregate, aggregateReviewResults } from "../ai-review/review-result";

/** AI同期1回分の結果（各段の生結果を保持する薄い集約） */
export interface AdoptOutcome {
	/** sync(adopt+align) の結果。設定不正等で実行できなかった場合は undefined */
	sync: SyncResult | undefined;
	/** AIペアリング検証のファイル別結果 */
	review: AiReviewFileResult[];
	/** レビュー段が dryRun（マーカー不変）だったか */
	dryRun: boolean;
	/** sync が実行されず中断したか（設定不正など） */
	aborted: boolean;
}

/**
 * sync 段の主要カウントを1行に整形する（レポート/サマリ共有）。
 */
export function formatSyncLine(sync: SyncResult): string {
	return (
		`adopted: ${sync.totalAdopted} | align-corrected: ${sync.totalAlignCorrections} | ` +
		`added: ${sync.totalAdded} | deleted: ${sync.totalDeleted} | kept: ${sync.totalKept} | ` +
		`orphan-reviewed: ${sync.totalOrphanReviewed}`
	);
}

/**
 * AI同期の合成レポート（Markdown）を生成する（純関数・テスト可能）。
 * sync 段のサマリ → レビュー段のサマリ → レビュー表（ファイル別）の順で構成する。
 */
export function generateAdoptReportContent(outcome: AdoptOutcome): string {
	const lines: string[] = ["# mdait AI Sync", ""];

	lines.push("## Sync (adopt + AI align)", "");
	if (outcome.aborted || !outcome.sync) {
		lines.push("Sync did not run (check the mdait configuration).", "");
	} else {
		lines.push(
			`files: ${outcome.sync.totalFileCount} processed, ${outcome.sync.errorCount} failed`,
			formatSyncLine(outcome.sync),
			"",
		);
	}

	const agg = aggregateReviewResults(outcome.review);
	lines.push("## AI Pairing Review", "");
	if (outcome.dryRun) {
		lines.push("_dry run: no markers were changed._", "");
	}
	lines.push(
		`verified: ${agg.verified} | approved: ${agg.approved} | escalated: ${agg.escalated} | ` +
			`kept: ${agg.kept} | skipped: ${agg.skipped} | errors: ${agg.errors}`,
		"",
	);
	const table = generateReviewTableSection(outcome.review);
	if (table.trim().length > 0) {
		lines.push(table);
	}

	return lines.join("\n");
}

/**
 * AI同期後のエージェント向け次アクションを生成する（純関数）。
 * sync 段の採用・アライン結果とレビュー段の集計から、TM 登録・手動レビュー等へ誘導する。
 */
export function buildAdoptNextActions(outcome: AdoptOutcome, agg: ReviewAggregate = aggregateReviewResults(outcome.review)): string[] {
	const actions: string[] = [];

	if (outcome.aborted || !outcome.sync) {
		actions.push(
			"Sync did not run. Check .mdait/mdait.json (transPairs, primaryLang) and retry mdait_aiSync.",
		);
		return actions;
	}

	if (agg.mismatch > 0) {
		actions.push(
			`${agg.mismatch} unit(s) look mis-paired (verdict:mismatch) even after AI align. Inspect the heading correspondence in the report, fix the document structure manually, then run mdait_aiSync (or mdait_sync) again to re-pair.`,
		);
	}
	if (agg.partial > 0) {
		actions.push(
			`${agg.partial} unit(s) look like incomplete translations (verdict:partial). Fix the translation manually, or remove the translated body and set need:translate to re-translate with mdait_translate.`,
		);
	}
	if (agg.uncertain + agg.keptBelowThreshold > 0) {
		actions.push(
			`${agg.uncertain + agg.keptBelowThreshold} unit(s) were kept as need:review (uncertain or below the auto-approve threshold). Review them manually and remove the need:review flag to approve.`,
		);
	}
	if (outcome.dryRun && agg.verified > 0) {
		actions.push(
			"This was a dry run: no markers were changed. Re-run mdait_aiSync without dryRun to apply auto-approval.",
		);
	}
	if (agg.approved > 0) {
		actions.push(
			`${agg.approved} unit(s) were auto-approved (need:review removed). Run mdait_tm (action:"commit") to register the approved pairs into the translation memory.`,
		);
	}
	if (actions.length === 0) {
		actions.push(
			"AI sync is clean: no adopted pairs required attention. Run mdait_getStatus to confirm the overall state, or mdait_tm (action:\"commit\") to register translated pairs.",
		);
	}
	return actions;
}
