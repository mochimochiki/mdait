/**
 * @file pair-collector.ts
 * @description
 *   AIペアリング検証の対象ペア列挙。
 *   ターゲット側の「from あり ∧ need:review」のユニットを、from ハッシュで
 *   ソースユニットに対応付ける純関数。VS Code API 非依存。
 * @module commands/ai-sync/pair-collector
 */

import type { MdaitUnit } from "../../core/markdown/mdait-unit";

/** 検証対象のソース・ターゲットペア */
export interface ReviewPair {
	targetUnit: MdaitUnit;
	/** from ハッシュで解決したソースユニット。未解決の場合は null（skipped 扱い） */
	sourceUnit: MdaitUnit | null;
}

/**
 * 検証対象ペアを列挙する。
 * 対象条件: target.marker.from があり、target.marker.need === "review"。
 * ソースは hash → unit の Map で解決する（順序ではなく from リンクに従う）。
 */
export function collectReviewPairs(sourceUnits: MdaitUnit[], targetUnits: MdaitUnit[]): ReviewPair[] {
	const sourceByHash = new Map<string, MdaitUnit>();
	for (const unit of sourceUnits) {
		if (unit.marker?.hash) {
			sourceByHash.set(unit.marker.hash, unit);
		}
	}

	const pairs: ReviewPair[] = [];
	for (const target of targetUnits) {
		const from = target.marker?.from;
		if (!from || target.marker?.need !== "review") {
			continue;
		}
		pairs.push({
			targetUnit: target,
			sourceUnit: sourceByHash.get(from) ?? null,
		});
	}
	return pairs;
}
