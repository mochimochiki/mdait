/**
 * @file review-constants.ts
 * @description
 *   aiReview の副作用なし定数。lm-tools（ツール出力で閾値を表示するだけ）が
 *   review-core（vscode / markdown parser 等の重い依存）を巻き込まずに参照できるよう
 *   独立モジュールへ切り出す。review-core と lm-tools の双方がここを参照する。
 * @module commands/ai-review/review-constants
 */

/**
 * 自動承認に必要な confidence の閾値（最適値で固定・設定廃止）。
 * 自動承認は「verdict=match ∧ issues空 ∧ confidence >= この値」の三重条件でのみ発動する。
 */
export const AUTO_APPROVE_THRESHOLD = 0.9;
