/**
 * @file review-result.ts
 * @description
 *   AIペアリング検証の結果型と判定→アクションの純関数。
 *   VS Code API 非依存（単体テストの中心）。
 * @module commands/ai-sync/review-result
 */

/** AIの判定語彙（ADR-260704-07 で固定） */
export type PairVerdict = "match" | "mismatch" | "partial" | "uncertain";

/** verdict 語彙の一覧（バリデーション用） */
export const PAIR_VERDICTS: readonly PairVerdict[] = ["match", "mismatch", "partial", "uncertain"];

/** 1ユニットに対して実際に取ったアクション */
export type ReviewAction =
	| "approved" // need:review を自動解除した
	| "escalated" // mismatch/partial として人間レビューへエスカレーション（need:review 維持）
	| "flagged" // audit モードで確定済みペアにドリフトを検出し報告した（マーカー不変）
	| "accepted" // audit モードで受理台帳に「意図的な乖離」として受理済み → AI 検証をスキップ
	| "audited" // audit モードで確定済みペアを検証しクリーン（変更なし）
	| "kept" // uncertain / 閾値未満 / autoApprove 無効（need:review 維持）
	| "skipped" // 検証不能（ソースユニット未解決など）
	| "error"; // AI応答の失敗（リトライ枯渇・例外）

/** AI応答のパース済み表現 */
export interface ParsedVerifyResponse {
	verdict: PairVerdict;
	/** 0..1 にクランプ済み */
	confidence: number;
	/** 問題点の短い英語ノート（省略時は空配列） */
	issues: string[];
	/** 判定理由の1文 */
	reason: string;
}

/** 判定→アクションのポリシー */
export interface ReviewPolicy {
	autoApprove: boolean;
	/** 自動承認の confidence 閾値（0..1） */
	threshold: number;
}

/** 1ユニット分の検証結果 */
export interface UnitReviewResult {
	filePath: string;
	unitHash: string;
	fromHash: string;
	title?: string;
	verdict?: PairVerdict;
	confidence?: number;
	issues: string[];
	reason?: string;
	action: ReviewAction;
}

/** 1ファイル分の検証結果 */
export interface AiReviewFileResult {
	filePath: string;
	/** AI検証を実行したユニット数 */
	verified: number;
	approved: number;
	escalated: number;
	/** audit: 確定済みペアにドリフトを検出し報告した数（マーカー不変） */
	flagged: number;
	/** audit: 受理台帳に受理済みで AI 検証をスキップした数 */
	accepted: number;
	/** audit: 確定済みペアを検証しクリーンだった数（変更なし） */
	audited: number;
	kept: number;
	skipped: number;
	errors: number;
	unitResults: UnitReviewResult[];
	/** マーカーを変更してファイルへ書き戻したか */
	markersChanged: boolean;
}

/** 空のファイル結果を生成する */
export function createEmptyFileResult(filePath: string): AiReviewFileResult {
	return {
		filePath,
		verified: 0,
		approved: 0,
		escalated: 0,
		flagged: 0,
		accepted: 0,
		audited: 0,
		kept: 0,
		skipped: 0,
		errors: 0,
		unitResults: [],
		markersChanged: false,
	};
}

/**
 * verdict とポリシーから取るべきアクションを決定する。
 * 自動承認は「match ∧ issues空 ∧ confidence >= threshold ∧ autoApprove」の場合のみ（ADR-260704-07）。
 */
export function decideReviewAction(
	parsed: ParsedVerifyResponse,
	policy: ReviewPolicy,
): "approve" | "escalate" | "keep" {
	if (parsed.verdict === "mismatch" || parsed.verdict === "partial") {
		return "escalate";
	}
	if (parsed.verdict !== "match") {
		return "keep";
	}
	if (!policy.autoApprove || parsed.issues.length > 0 || parsed.confidence < policy.threshold) {
		return "keep";
	}
	return "approve";
}

/** 複数ファイルの検証結果を集計した内訳（VS Code 非依存・純関数の出力） */
export interface ReviewAggregate {
	/** need:review ユニットを持っていたファイル数 */
	filesWithUnits: number;
	verified: number;
	approved: number;
	/** escalated のうち verdict:mismatch */
	mismatch: number;
	/** escalated のうち verdict:partial */
	partial: number;
	/** kept のうち verdict:uncertain */
	uncertain: number;
	/** kept のうち match だが閾値未満/issuesあり/autoApprove無効 */
	keptBelowThreshold: number;
	/** escalated 合計（mismatch + partial） */
	escalated: number;
	/** audit: 確定済みペアにドリフトを検出し報告した数（マーカー不変） */
	flagged: number;
	/** audit: 受理台帳に受理済みで AI 検証をスキップした数 */
	accepted: number;
	/** audit: 確定済みペアを検証しクリーンだった数（変更なし） */
	audited: number;
	/** kept 合計（uncertain + keptBelowThreshold） */
	kept: number;
	skipped: number;
	errors: number;
}

/**
 * 複数ファイルの検証結果を集計する（純関数）。
 * mdait_aiReview / mdait_aiSync のエンベロープ・レポートが共有する。
 * kept は verdict:uncertain と「match だが未承認」を区別して数える（ADR-260704-07）。
 */
export function aggregateReviewResults(results: AiReviewFileResult[]): ReviewAggregate {
	const agg: ReviewAggregate = {
		filesWithUnits: 0,
		verified: 0,
		approved: 0,
		mismatch: 0,
		partial: 0,
		uncertain: 0,
		keptBelowThreshold: 0,
		escalated: 0,
		flagged: 0,
		accepted: 0,
		audited: 0,
		kept: 0,
		skipped: 0,
		errors: 0,
	};
	for (const fileResult of results) {
		if (fileResult.unitResults.length > 0) {
			agg.filesWithUnits++;
		}
		agg.verified += fileResult.verified;
		agg.approved += fileResult.approved;
		agg.flagged += fileResult.flagged;
		agg.accepted += fileResult.accepted;
		agg.audited += fileResult.audited;
		agg.errors += fileResult.errors;
		agg.skipped += fileResult.skipped;
		for (const unit of fileResult.unitResults) {
			if (unit.action === "escalated") {
				if (unit.verdict === "mismatch") {
					agg.mismatch++;
				} else {
					agg.partial++;
				}
			} else if (unit.action === "kept") {
				if (unit.verdict === "uncertain") {
					agg.uncertain++;
				} else {
					agg.keptBelowThreshold++;
				}
			}
		}
	}
	agg.escalated = agg.mismatch + agg.partial;
	agg.kept = agg.uncertain + agg.keptBelowThreshold;
	return agg;
}

/**
 * hover（SummaryManager.reviewReasons）向けの判定サマリ文字列を生成する。
 */
export function formatReviewReason(parsed: ParsedVerifyResponse): string {
	const confidence = parsed.confidence.toFixed(2);
	const base = `AI pairing review: ${parsed.verdict} (${confidence}) — ${parsed.reason}`;
	if (parsed.issues.length === 0) {
		return base;
	}
	return `${base} | issues: ${parsed.issues.join("; ")}`;
}
