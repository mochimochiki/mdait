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
 * 包括方式（許可リスト）: 「from属性あり ∧ need が null」のみ登録対象。
 * need が何であれ付いているユニットは確定した対訳ではないため対象外とし、
 * 未知の need が素通りする列挙の穴を構造的に塞ぐ。
 */
export function isTmCommitTarget(unit: MdaitUnit): boolean {
	if (!unit.marker?.from) {
		return false;
	}
	return unit.marker.need === null;
}

/** TM登録スキップの理由 */
export type TmSkipReason =
	| "noFrom"
	| "needTranslate"
	| "needRevise"
	| "needReview"
	| "needIsolate"
	| "needOther"
	| "sourcePending";

/** スキップ理由の内訳（エージェントが「なぜコミットされないか」を診断するための集計） */
export interface TmSkipReasonBreakdown {
	noFrom: number;
	needTranslate: number;
	needRevise: number;
	needReview: number;
	needIsolate: number;
	needOther: number;
	/** ペア解決時に source 側ユニットへ need が付いていたためスキップした数（commit 側で集計） */
	sourcePending: number;
}

/**
 * ユニットのTM登録スキップ理由を分類する。
 * 登録対象（スキップしない）の場合は null を返す。
 * target 単体の純関数であり "sourcePending" は返さない（source 側の need は commit 側で判定する）。
 */
export function classifyTmSkipReason(unit: MdaitUnit): TmSkipReason | null {
	if (!unit.marker?.from) {
		return "noFrom";
	}
	const need = unit.marker.need;
	if (need === null) {
		return null;
	}
	if (need === "translate") {
		return "needTranslate";
	}
	if (need.startsWith("revise@")) {
		return "needRevise";
	}
	if (need === "review") {
		return "needReview";
	}
	if (need === "isolate") {
		return "needIsolate";
	}
	// verify-deletion やレガシー値を含む、その他すべての need
	return "needOther";
}

/** 空のスキップ理由内訳を生成する */
export function emptyTmSkipReasonBreakdown(): TmSkipReasonBreakdown {
	return {
		noFrom: 0,
		needTranslate: 0,
		needRevise: 0,
		needReview: 0,
		needIsolate: 0,
		needOther: 0,
		sourcePending: 0,
	};
}

/**
 * ユニット群のスキップ理由内訳を集計する
 */
export function summarizeTmSkipReasons(units: readonly MdaitUnit[]): TmSkipReasonBreakdown {
	const breakdown = emptyTmSkipReasonBreakdown();
	for (const unit of units) {
		const reason = classifyTmSkipReason(unit);
		if (reason) {
			breakdown[reason]++;
		}
	}
	return breakdown;
}
