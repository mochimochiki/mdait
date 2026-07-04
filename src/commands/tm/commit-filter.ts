/**
 * @file commit-filter.ts
 * @description
 *   TM登録対象のフィルタリングロジック。
 *   ユニットがTM処理対象かどうかを判定する純粋関数。
 * @module commands/tm/commit-filter
 */
import type { MdaitUnit } from "../../core/markdown/mdait-unit";

/**
 * ユニットがTM処理対象かどうか判定する。
 *
 * 対象条件:
 * - from属性あり（ターゲットファイルのユニット）
 * - need:translate でない（翻訳済み）
 * - need:revise@ でない（旧版訳文）
 * - need:review でない（レビュー待ち）
 * - need:keep でない（独自ユニット。対訳が存在しない）
 */
export function isTmCommitTarget(unit: MdaitUnit): boolean {
	if (!unit.marker?.from) {
		return false;
	}
	if (unit.marker.need === "translate") {
		return false;
	}
	if (unit.marker.need?.startsWith("revise@")) {
		return false;
	}
	if (unit.marker.need === "review") {
		return false;
	}
	if (unit.marker.need === "keep") {
		return false;
	}
	return true;
}

/** TM登録スキップの理由 */
export type TmSkipReason =
	| "noFrom"
	| "needTranslate"
	| "needRevise"
	| "needReview"
	| "needKeep";

/** スキップ理由の内訳（エージェントが「なぜコミットされないか」を診断するための集計） */
export interface TmSkipReasonBreakdown {
	noFrom: number;
	needTranslate: number;
	needRevise: number;
	needReview: number;
	needKeep: number;
}

/**
 * ユニットのTM登録スキップ理由を分類する。
 * 登録対象（スキップしない）の場合は null を返す。
 */
export function classifyTmSkipReason(unit: MdaitUnit): TmSkipReason | null {
	if (!unit.marker?.from) {
		return "noFrom";
	}
	if (unit.marker.need === "translate") {
		return "needTranslate";
	}
	if (unit.marker.need?.startsWith("revise@")) {
		return "needRevise";
	}
	if (unit.marker.need === "review") {
		return "needReview";
	}
	if (unit.marker.need === "keep") {
		return "needKeep";
	}
	return null;
}

/**
 * ユニット群のスキップ理由内訳を集計する
 */
export function summarizeTmSkipReasons(units: readonly MdaitUnit[]): TmSkipReasonBreakdown {
	const breakdown: TmSkipReasonBreakdown = {
		noFrom: 0,
		needTranslate: 0,
		needRevise: 0,
		needReview: 0,
		needKeep: 0,
	};
	for (const unit of units) {
		const reason = classifyTmSkipReason(unit);
		if (reason) {
			breakdown[reason]++;
		}
	}
	return breakdown;
}
