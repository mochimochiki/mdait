/**
 * @file commit-filter.ts
 * @description
 *   TM登録対象のフィルタリングロジック。
 *   ユニットがTM処理対象かどうかを判定する純粋関数。
 * @module commands/tm/commit-filter
 */
import type { MdaitUnit } from "../../core/markdown/mdait-unit";

/**
 * 受理台帳の受理判定を注入するための述語。
 * `(targetHash, fromHash)` が「意図的な乖離」として受理済みなら true を返す。
 */
export type AcceptedPredicate = (targetHash: string, fromHash: string) => boolean;

/** ユニットが受理台帳に受理済みかを判定する（marker が揃っている場合のみ） */
function isUnitAccepted(unit: MdaitUnit, isAccepted?: AcceptedPredicate): boolean {
	if (!isAccepted || !unit.marker?.hash || !unit.marker.from) {
		return false;
	}
	return isAccepted(unit.marker.hash, unit.marker.from);
}

/**
 * ユニットがTM処理対象かどうか判定する。
 *
 * 対象条件:
 * - from属性あり（ターゲットファイルのユニット）
 * - need:translate でない（翻訳済み）
 * - need:revise@ でない（旧版訳文）
 * - need:review でない（レビュー待ち）
 * - need:keep でない（独自ユニット。対訳が存在しない）
 * - audit の受理台帳に「意図的な乖離」として受理済みでない（AI が partial/mismatch と
 *   判定した訳を人間が意図的と認めたもの。他の翻訳へ汚染しないよう安全側で除外する）
 *
 * @param isAccepted 受理台帳の判定述語（省略時は受理除外を行わない＝従来挙動）
 */
export function isTmCommitTarget(unit: MdaitUnit, isAccepted?: AcceptedPredicate): boolean {
	return classifyTmSkipReason(unit, isAccepted) === null;
}

/** TM登録スキップの理由 */
export type TmSkipReason =
	| "noFrom"
	| "needTranslate"
	| "needRevise"
	| "needReview"
	| "needKeep"
	| "audited";

/** スキップ理由の内訳（エージェントが「なぜコミットされないか」を診断するための集計） */
export interface TmSkipReasonBreakdown {
	noFrom: number;
	needTranslate: number;
	needRevise: number;
	needReview: number;
	needKeep: number;
	/** audit の受理台帳で「意図的な乖離」として受理され TM 除外されたペア数 */
	audited: number;
}

/**
 * ユニットのTM登録スキップ理由を分類する。
 * 登録対象（スキップしない）の場合は null を返す。
 * @param isAccepted 受理台帳の判定述語（省略時は受理除外を行わない）
 */
export function classifyTmSkipReason(unit: MdaitUnit, isAccepted?: AcceptedPredicate): TmSkipReason | null {
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
	if (isUnitAccepted(unit, isAccepted)) {
		return "audited";
	}
	return null;
}

/**
 * ユニット群のスキップ理由内訳を集計する
 * @param isAccepted 受理台帳の判定述語（省略時は受理除外を行わない）
 */
export function summarizeTmSkipReasons(
	units: readonly MdaitUnit[],
	isAccepted?: AcceptedPredicate,
): TmSkipReasonBreakdown {
	const breakdown: TmSkipReasonBreakdown = {
		noFrom: 0,
		needTranslate: 0,
		needRevise: 0,
		needReview: 0,
		needKeep: 0,
		audited: 0,
	};
	for (const unit of units) {
		const reason = classifyTmSkipReason(unit, isAccepted);
		if (reason) {
			breakdown[reason]++;
		}
	}
	return breakdown;
}
