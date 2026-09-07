import { rankTmEntries } from "./tm-ranker";
import type { TmEntry } from "./types";

const TOP_K = 5;
const RANK_POINTS = [1.0, 0.7, 0.5, 0.2, 0.1] as const;

function clamp01(value: number): number {
	return Math.min(1, Math.max(0, value));
}

/**
 * corpusPresence + retrievalUsefulness に基づいて TU 重みを再計算する。
 */
export function recomputeTmWeights(
	entries: readonly TmEntry[],
	queries: readonly string[],
	primaryLang: string,
): Map<string, number> {
	const corpusSet = new Set(queries);
	const usefulness = new Map<string, number>();

	for (const query of queries) {
		// **いま入っている重みは見ない。** 見ると「重みを入力にして重みを出す」ことになり、
		// 同じ TM でも流した回数で答えが変わる（ADR-260907-03）
		const ranked = rankTmEntries(query, [...entries], {
			lang: primaryLang,
			topK: TOP_K,
			lambda: 1,
			ignoreWeight: true,
		});
		for (let i = 0; i < ranked.length && i < RANK_POINTS.length; i++) {
			const point = RANK_POINTS[i];
			const tuid = ranked[i].tuid;
			usefulness.set(tuid, (usefulness.get(tuid) ?? 0) + point);
		}
	}

	const maxUsefulness = Math.max(0, ...usefulness.values());
	const weights = new Map<string, number>();

	for (const entry of entries) {
		const corpusPresence = corpusSet.has(entry.primary) ? 1 : 0;
		const usefulnessRaw = usefulness.get(entry.tuid) ?? 0;
		const retrievalUsefulness = maxUsefulness > 0 ? usefulnessRaw / maxUsefulness : 0;
		const weight = clamp01(0.7 * corpusPresence + 0.3 * retrievalUsefulness);
		weights.set(entry.tuid, weight);
	}

	return weights;
}
