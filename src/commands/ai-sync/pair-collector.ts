/**
 * @file pair-collector.ts
 * @description
 *   AIレビューの対象ペア列挙。
 *   ターゲット側のユニットを from ハッシュでソースユニットに対応付ける純関数。
 *   VS Code API 非依存。
 *   - mode="pending": 「from あり ∧ need:review」のみ（AIペアリング検証・既定）
 *   - mode="audit": 「from あり ∧（need:review または need なし）」＝確定済みペアも監査対象
 * @module commands/ai-sync/pair-collector
 */

import type { MdaitUnit } from "../../core/markdown/mdait-unit";

/** レビュー対象ペアの列挙モード */
export type ReviewCollectMode = "pending" | "audit";

/** 検証対象のソース・ターゲットペア */
export interface ReviewPair {
	targetUnit: MdaitUnit;
	/** from ハッシュで解決したソースユニット。未解決の場合は null（skipped 扱い） */
	sourceUnit: MdaitUnit | null;
}

/**
 * 検証対象ペアを列挙する。
 * ソースは hash → unit の Map で解決する（順序ではなく from リンクに従う）。
 *
 * 対象条件（いずれも target.marker.from が必須）:
 * - "pending": target.marker.need === "review"（既存挙動）
 * - "audit": target.marker.need === "review" または need なし（確定済みペア）。
 *   translate / revise@ / isolate / verify-deletion 等の
 *   in-flight 状態は監査対象外（確定した対訳ではないため）。
 */
export function collectReviewPairs(
	sourceUnits: MdaitUnit[],
	targetUnits: MdaitUnit[],
	mode: ReviewCollectMode = "pending",
): ReviewPair[] {
	const sourceByHash = new Map<string, MdaitUnit>();
	for (const unit of sourceUnits) {
		if (unit.marker?.hash) {
			sourceByHash.set(unit.marker.hash, unit);
		}
	}

	const pairs: ReviewPair[] = [];
	for (const target of targetUnits) {
		const from = target.marker?.from;
		if (!from || !isReviewTarget(target.marker?.need ?? null, mode)) {
			continue;
		}
		pairs.push({
			targetUnit: target,
			sourceUnit: sourceByHash.get(from) ?? null,
		});
	}
	return pairs;
}

/**
 * need 値が指定モードの検証対象かを判定する。
 * audit では「need:review」に加えて「確定済み（need なし）」も対象に含める。
 */
function isReviewTarget(need: string | null, mode: ReviewCollectMode): boolean {
	if (need === "review") {
		return true;
	}
	return mode === "audit" && (need === null || need === "");
}
