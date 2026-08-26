/**
 * @file adopt-result.ts
 * @description
 *   既存翻訳の取り込みウィザードの結果型とレポート/nextActions 生成の純関数。
 *   VS Code API 非依存（単体テストの中心）。合成側は新しいマーカー変異を
 *   導入せず、各段（sync(adopt)+align / AI翻訳レビュー / 用語集 / TM）の結果を集計するだけ。
 * @module commands/adopt/adopt-result
 */

import { type AiReviewFileResult, type ReviewAggregate, aggregateReviewResults } from "../ai-review/review-result";
import { type ReviewTableOptions, generateReviewTableSection } from "../ai-review/review-table";
import type { SyncResult } from "../sync/sync-command";

/** 用語集構築段（term.detect → term.expand）の集計 */
export interface AdoptTermSummary {
	/** 新規検出された用語数 */
	detected: number;
	/** 今回訳語を補完できた用語数 */
	expanded: number;
	/** 訳語未解決のまま残った用語数 */
	remaining: number;
}

/** TM構築段（tm.commit）の全ファイル加算集計 */
export interface AdoptTmSummary {
	/** 処理したターゲットファイル数 */
	files: number;
	/** TM 登録処理されたユニット数 */
	processedUnits: number;
	/** 新規登録された文ペア数 */
	newEntries: number;
	/** 既存更新された文ペア数 */
	existingEntries: number;
	/** warning 件数 */
	warnedEntries: number;
	/** エラーが発生したユニット数 */
	errorUnits: number;
}

/** オプション段（用語集・TM）の失敗記録。記録して続行し、レポートで可視化する */
export interface AdoptStageError {
	stage: "termDetect" | "termExpand" | "tmCommit";
	/** transPair（"ja -> en"）またはファイルパス */
	scope?: string;
	message: string;
}

/** 取り込みウィザード1回分の結果（各段の生結果を保持する薄い集約） */
export interface AdoptOutcome {
	/** sync(adopt+align) の結果。設定不正等で実行できなかった場合は undefined */
	sync: SyncResult | undefined;
	/** AI翻訳レビューのファイル別結果 */
	review: AiReviewFileResult[];
	/** 用語集構築段の集計（buildGlossary 選択時のみ） */
	term?: AdoptTermSummary;
	/** TM構築段の集計（buildTm 選択時のみ） */
	tm?: AdoptTmSummary;
	/** オプション段の失敗記録 */
	stageErrors: AdoptStageError[];
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
 * 統合レポートの見出し・定型文（表示言語化のために VS Code 層から注入する。
 * 既定は英語 — 純関数のままテストできるようにするため。ADR-260719-01）。
 * 件数の語彙行（`adopted: 3 | ...`）はエージェントとの共通語彙なので英語固定とする。
 */
export interface AdoptReportLabels {
	title: string;
	syncHeading: string;
	syncNotRun: string;
	/** `files: {0} processed, {1} failed` 相当 */
	filesLine: (processed: number, failed: number) => string;
	reviewHeading: string;
	dryRunNote: string;
	glossaryHeading: string;
	tmHeading: string;
	stageErrorsHeading: string;
}

/** ラベル未注入時の既定（英語） */
export const DEFAULT_ADOPT_REPORT_LABELS: AdoptReportLabels = {
	title: "mdait Adopt Existing Translations",
	syncHeading: "Sync (adopt + AI align)",
	syncNotRun: "Sync did not run (check the mdait configuration).",
	filesLine: (processed, failed) => `files: ${processed} processed, ${failed} failed`,
	reviewHeading: "AI Translation Review",
	dryRunNote: "_dry run: no markers were changed; glossary and TM steps were skipped._",
	glossaryHeading: "Glossary",
	tmHeading: "Translation Memory",
	stageErrorsHeading: "Stage errors",
};

/** レポート生成のオプション */
export interface AdoptReportOptions extends ReviewTableOptions {
	/** 見出し・定型文のラベル（省略時は英語の既定） */
	labels?: AdoptReportLabels;
}

/**
 * 取り込みウィザードの統合レポート（Markdown）を生成する（純関数・テスト可能）。
 * sync 段 → レビュー段 → 用語集段 → TM 段 → 段エラーの順で構成する
 * （オプション段のセクションは実行時のみ出力）。
 *
 * @param outcome 取り込み1回分の結果
 * @param options ラベル注入（表示言語化）とユニット行リンクの基準ディレクトリ
 */
export function generateAdoptReportContent(outcome: AdoptOutcome, options: AdoptReportOptions = {}): string {
	const labels = options.labels ?? DEFAULT_ADOPT_REPORT_LABELS;
	const lines: string[] = [`# ${labels.title}`, ""];

	lines.push(`## ${labels.syncHeading}`, "");
	if (outcome.aborted || !outcome.sync) {
		lines.push(labels.syncNotRun, "");
	} else {
		lines.push(
			labels.filesLine(outcome.sync.totalFileCount, outcome.sync.errorCount),
			formatSyncLine(outcome.sync),
			"",
		);
	}

	const agg = aggregateReviewResults(outcome.review);
	lines.push(`## ${labels.reviewHeading}`, "");
	if (outcome.dryRun) {
		lines.push(labels.dryRunNote, "");
	}
	lines.push(
		`verified: ${agg.verified} | approved: ${agg.approved} | escalated: ${agg.escalated} | ` +
			`kept: ${agg.kept} | skipped: ${agg.skipped} | errors: ${agg.errors}`,
		"",
	);
	const table = generateReviewTableSection(outcome.review, { linkBaseDir: options.linkBaseDir });
	if (table.trim().length > 0) {
		lines.push(table);
	}

	if (outcome.term) {
		lines.push(`## ${labels.glossaryHeading}`, "");
		lines.push(
			`detected: ${outcome.term.detected} | expanded: ${outcome.term.expanded} | remaining: ${outcome.term.remaining}`,
			"",
		);
	}

	if (outcome.tm) {
		lines.push(`## ${labels.tmHeading}`, "");
		lines.push(
			`files: ${outcome.tm.files} | units: ${outcome.tm.processedUnits} | new: ${outcome.tm.newEntries} | ` +
				`updated: ${outcome.tm.existingEntries} | warnings: ${outcome.tm.warnedEntries} | errors: ${outcome.tm.errorUnits}`,
			"",
		);
	}

	if (outcome.stageErrors.length > 0) {
		lines.push(`## ${labels.stageErrorsHeading}`, "");
		for (const err of outcome.stageErrors) {
			lines.push(`- ${err.stage}${err.scope ? ` (${err.scope})` : ""}: ${err.message}`);
		}
		lines.push("");
	}

	return lines.join("\n");
}

/**
 * 取り込み後のエージェント/ユーザー向け次アクションを生成する（純関数）。
 * sync 段の採用・アライン結果とレビュー段の集計から、TM 登録・手動レビュー等へ誘導する。
 * TM 段を実行した場合は「エスカレーション残りは TM 未登録＝解消後の再コミット」を必ず案内する
 * （escalated 多数時に TM がほぼ空になるケースの受け皿）。
 */
export function buildAdoptNextActions(
	outcome: AdoptOutcome,
	agg: ReviewAggregate = aggregateReviewResults(outcome.review),
): string[] {
	const actions: string[] = [];

	if (outcome.aborted || !outcome.sync) {
		actions.push("Sync did not run. Check .mdait/mdait.json (transPairs, primaryLang) and retry mdait_adopt.");
		return actions;
	}

	// レビューが1件も成立しなかったことを、いちばん先に言う。
	// ここを見落とすと `actions` が空のまま「取り込みは綺麗です」に落ち、
	// 誰も見ていないペアを TM へ登録する導線だけが残る（実測: errors=4 でも clean と出た）
	if (agg.errors > 0) {
		actions.push(
			`${agg.errors} unit(s) could not be reviewed (the AI errored or its answer could not be used) and still carry need:review. Re-run mdait_aiReview and confirm it succeeds before running mdait_tm (action:"commit").`,
		);
	}

	if (agg.mismatch > 0) {
		actions.push(
			`${agg.mismatch} unit(s) look mis-paired (verdict:mismatch) even after AI align. Inspect the heading correspondence in the report, fix the document structure manually, then run mdait_adopt (or mdait_sync) again to re-pair.`,
		);
	}
	if (agg.partial > 0) {
		actions.push(
			`${agg.partial} unit(s) look like incomplete translations (verdict:partial). Fix the translation manually, or remove the translated body and set need:translate to re-translate with mdait_translate.`,
		);
	}
	if (agg.uncertain + agg.keptBelowThreshold > 0) {
		actions.push(
			`${agg.uncertain + agg.keptBelowThreshold} unit(s) were kept as need:review (uncertain or below the auto-approve threshold). Review them manually and run mdait_resolve to remove the need:review flags of the verified units.`,
		);
	}
	if (outcome.dryRun && agg.verified > 0) {
		actions.push(
			"This was a dry run: no markers were changed. Re-run mdait_adopt without dryRun to apply auto-approval.",
		);
	}
	if (outcome.tm && agg.escalated + agg.kept > 0) {
		actions.push(
			`${agg.escalated + agg.kept} unit(s) still carry need:review and were excluded from the TM. After resolving the reviews, run mdait_tm (action:"commit") again to register them.`,
		);
	}
	if (!outcome.tm && agg.approved > 0) {
		actions.push(
			`${agg.approved} unit(s) were auto-approved (need:review removed). Run mdait_tm (action:"commit") to register the approved pairs into the translation memory.`,
		);
	}
	if (outcome.term && outcome.term.remaining > 0) {
		actions.push(
			`${outcome.term.remaining} glossary term(s) still lack translations. Re-run term expansion (mdait_term) after more pairs are approved.`,
		);
	}
	if (actions.length === 0) {
		actions.push(
			'Adoption is clean: no adopted pairs required attention. Run mdait_getStatus to confirm the overall state, or mdait_tm (action:"commit") to register translated pairs.',
		);
	}
	return actions;
}
