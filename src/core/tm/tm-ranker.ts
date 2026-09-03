/**
 * @file tm-ranker.ts
 * @description
 *   翻訳メモリの候補をスコアリングし、MMR（Maximal Marginal Relevance）で多様性を考慮しつつ
 *   上位k件を選択するランキングエンジン。
 *   trigram Jaccard 係数でクエリとの類似度を計算し、MMR greedy 選択で topK 件を返す。
 * @module core/tm/tm-ranker
 */

import { computeTrigrams, normalizeForTm } from "./tm-text-normalizer";
import type { TmEntry } from "./types";

/** スコア付き TmEntry */
export type ScoredTmEntry = TmEntry & { score: number };

/** rankTmEntries のオプション */
export interface RankOptions {
	/** 返す最大件数（デフォルト: 5） */
	topK?: number;
	/** MMR λ: 1.0 = 純粋な類似度順、0.0 = 純粋な多様性重視（デフォルト: 0.7） */
	lambda?: number;
	/** スコアリング対象言語（sourceLang を渡す） */
	lang: string;
	/** TmxStore.getTrigramCache() から渡されるキャッシュ（省略可）。
	 * キー: "${tuid}:${lang}" — 存在する場合は候補の trigram 再計算をスキップする */
	trigramCache?: ReadonlyMap<string, ReadonlySet<string>>;
}

/** trigram インデックス用の内部候補型 */
type CandidateWithTrigrams = {
	entry: TmEntry;
	trigrams: ReadonlySet<string>;
	querySim: number;
	finalScore: number;
};

function applyWeightBoost(similarityScore: number, weight: number): number {
	const safeWeight = Number.isFinite(weight) ? Math.min(1, Math.max(0, weight)) : 1;
	return similarityScore * (0.7 + 0.3 * safeWeight);
}

/**
 * 2つの trigram 集合の Jaccard 係数を計算する。
 * 両方が空集合の場合は 0 を返す。
 */
function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
	if (a.size === 0 || b.size === 0) {
		return 0;
	}
	let intersection = 0;
	for (const t of a) {
		if (b.has(t)) {
			intersection++;
		}
	}
	const union = a.size + b.size - intersection;
	return union === 0 ? 0 : intersection / union;
}

/**
 * TM 候補を trigram Jaccard + MMR でスコアリングし、上位 topK 件を返す。
 *
 * アルゴリズム:
 * 1. クエリと各候補の lang variant テキストを trigram 集合に変換
 * 2. Jaccard 係数で querySim を計算
 * 3. MMR greedy 選択: score = λ × querySim(c) − (1−λ) × max_{s∈selected}(sim(s, c))
 *
 * @param query 検索クエリテキスト（sourceContent）
 * @param candidates TM 候補エントリー配列（findCandidatesByTrigram の結果）
 * @param options ランキングオプション
 * @returns スコア付き TmEntry の配列（topK 件以内）
 */
export function rankTmEntries(query: string, candidates: TmEntry[], options: RankOptions): ScoredTmEntry[] {
	const { topK = 5, lambda = 0.7, lang } = options;

	const queryTrigrams = computeTrigrams(normalizeForTm(query));

	// lang variant を持つ候補のみをフィルタし、trigram とクエリ類似度をキャッシュ
	const pool: CandidateWithTrigrams[] = candidates
		.map((entry) => {
			const text = entry.variants.get(lang)?.text;
			if (text === undefined) {
				return null;
			}
			const trigrams = options.trigramCache?.get(`${entry.tuid}:${lang}`)
				?? computeTrigrams(normalizeForTm(text));
			const querySim = jaccard(queryTrigrams, trigrams);
			const finalScore = applyWeightBoost(querySim, entry.weight);
			return { entry, trigrams, querySim, finalScore };
		})
		.filter((c): c is CandidateWithTrigrams => c !== null);

	// finalScore 降順にソート（重み補正後の候補順）
	pool.sort((a, b) => b.finalScore - a.finalScore);

	const selected: Array<CandidateWithTrigrams & { score: number }> = [];
	const remaining = [...pool];

	while (selected.length < topK && remaining.length > 0) {
		let bestIdx = 0;
		let bestScore = Number.NEGATIVE_INFINITY;

		if (selected.length === 0) {
			// 初回: finalScore が最高の候補を選択
			bestIdx = 0;
			bestScore = remaining[0].finalScore;
		} else {
			for (let i = 0; i < remaining.length; i++) {
				const c = remaining[i];
				const maxSimToSelected = Math.max(...selected.map((s) => jaccard(s.trigrams, c.trigrams)));
				const score = lambda * c.finalScore - (1 - lambda) * maxSimToSelected;
				if (score > bestScore) {
					bestScore = score;
					bestIdx = i;
				}
			}
		}

		const [best] = remaining.splice(bestIdx, 1);
		selected.push({ ...best, score: bestScore });
	}

	return selected.map(({ entry, score }) => ({ ...entry, score }));
}
