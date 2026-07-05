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
