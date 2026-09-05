/**
 * @file tm-line-search.ts
 * @description
 *   ソーステキストを行単位に分割してTM検索を行い、結果を統合するオーケストレータ。
 *   revise時は旧ソースとの差分行のみを検索対象とする。
 * @module core/tm/tm-line-search
 */

import type { ScoredTmEntry } from "./tm-ranker";
import { rankTmEntries } from "./tm-ranker";
import { buildSentenceQueries } from "./tm-query";
import { normalizeForTm } from "./tm-text-normalizer";
import type { TmxStore } from "./tmx-store";
import type { TmMatch } from "./types";

/** searchTmByLines のオプション */
export interface TmLineSearchOptions {
	/** 最低クエリ文字数（これ未満の行は除外） */
	minQueryLength: number;
	/** 最終返却件数上限 */
	maxReferences: number;
	/** ソース言語コード */
	sourceLang: string;
	/** ターゲット言語コード */
	targetLang: string;
	/** TmxStore.getTrigramCache() から渡されるキャッシュ */
	trigramCache?: ReadonlyMap<string, ReadonlySet<string>>;
}

/** trigram絞り込みの上限候補数（行単位クエリはtrigram集合が小さいため50で十分） */
const TRIGRAM_CANDIDATE_LIMIT = 50;

/** Jaccardスコアの最低閾値（これ未満はノイズとして除外） */
const MIN_SCORE_THRESHOLD = 0.15;

/**
 * ソーステキストを行単位に分割してTM検索を行い、統合結果を返す。
 *
 * @param sourceContent 生テキスト（Markdown含む）
 * @param store TmxStoreインスタンス
 * @param options 検索オプション
 * @param oldSourceContent revise時の旧ソーステキスト（省略時は全行検索）
 * @returns TmMatch配列（maxReferences件以内、スコア降順）
 */
export function searchTmByLines(
	sourceContent: string,
	store: TmxStore,
	options: TmLineSearchOptions,
	oldSourceContent?: string,
): TmMatch[] {
	const { minQueryLength, maxReferences, sourceLang, targetLang, trigramCache } = options;

	// 1. 正規化・分割
	const queryLines = buildSentenceQueries(sourceContent, sourceLang, minQueryLength);

	// 2. revise差分フィルタ
	if (oldSourceContent !== undefined) {
		const oldLineSet = buildSentenceQueries(oldSourceContent, sourceLang, 0);
		for (const line of queryLines) {
			if (oldLineSet.has(line)) {
				queryLines.delete(line);
			}
		}
	}

	if (queryLines.size === 0) {
		return [];
	}

	// 3. 行ごと検索（行ごとの結果をスコア閾値でフィルタして保持）
	const perLineResults: Array<Array<{ entry: ScoredTmEntry; score: number }>> = [];

	for (const line of queryLines) {
		const candidates = store.findCandidatesByTrigram(line, sourceLang, TRIGRAM_CANDIDATE_LIMIT);
		if (candidates.length === 0) {
			perLineResults.push([]);
			continue;
		}
		const ranked = rankTmEntries(line, candidates, {
			topK: maxReferences,
			lang: sourceLang,
			trigramCache,
		});
		perLineResults.push(
			ranked.filter((e) => e.score >= MIN_SCORE_THRESHOLD).map((e) => ({ entry: e, score: e.score })),
		);
	}

	// 4. ラウンドロビン統合: 各行から1件ずつノミネート → スコア順で選択
	//    行数 > maxReferences のとき、先頭行だけが優遇されるのを防ぐ。
	//    全行を一周してスコア上位を選ぶことで公平かつ高品質なマッチを得る。
	const selectedTuids = new Set<string>();
	const matches: TmMatch[] = [];
	const pointers = perLineResults.map(() => 0);

	while (matches.length < maxReferences) {
		// 今ラウンドのノミネートを集める
		const nominees: Array<{ entry: ScoredTmEntry; score: number }> = [];
		for (let lineIdx = 0; lineIdx < perLineResults.length; lineIdx++) {
			const lineResults = perLineResults[lineIdx];
			while (pointers[lineIdx] < lineResults.length) {
				const candidate = lineResults[pointers[lineIdx]];
				pointers[lineIdx]++;
				if (selectedTuids.has(candidate.entry.tuid)) continue;
				if (!candidate.entry.variants.has(targetLang)) continue;
				nominees.push(candidate);
				break;
			}
		}
		if (nominees.length === 0) break;

		// スコア降順でソートし、残り枠分だけ選択
		nominees.sort((a, b) => b.score - a.score);
		const remaining = maxReferences - matches.length;
		const picked = nominees.slice(0, remaining);
		for (const { entry } of picked) {
			selectedTuids.add(entry.tuid);
			matches.push({
				sentenceHash: entry.tuid,
				source: entry.variants.get(sourceLang)?.text ?? "",
				target: entry.variants.get(targetLang)?.text ?? "",
				firstUsedIn: "",
				similarity: entry.similarity,
			});
		}
	}

	return matches;
}

/**
 * 原文・訳文の両方向でTM検索を行い、統合結果を返す。
 *
 * - forward: 原文 → TM原文側の類似検索（searchTmByLines そのまま）
 * - reverse: 訳文 → TM訳文側の類似検索（言語を入れ替えて検索し、source/target を戻す。
 *   searchTmByLines の「相手言語 variant 必須」フィルタにより対訳が揃ったエントリのみ返る）
 *
 * どちらか一方だけがヒットする参照は「同じ原文が別の訳になっている」「同じ訳が別の原文に
 * 使われている」兆候であり、訳揺れ検知の材料として AI翻訳レビュープロンプトに注入する。
 *
 * @param sourceContent 原文ユニット本文（Markdown含む生テキスト）
 * @param targetContent 訳文ユニット本文（Markdown含む生テキスト）
 * @param store TmxStoreインスタンス
 * @param options 検索オプション（sourceLang/targetLang は文書の向きで指定）
 * @returns TmMatch配列（tuid で重複排除、合計 maxReferences 件以内）
 */
export function searchTmBidirectional(
	sourceContent: string,
	targetContent: string,
	store: TmxStore,
	options: TmLineSearchOptions,
): TmMatch[] {
	const forward = searchTmByLines(sourceContent, store, options);
	const reverse = searchTmByLines(targetContent, store, {
		...options,
		sourceLang: options.targetLang,
		targetLang: options.sourceLang,
	}).map((m) => ({ ...m, source: m.target, target: m.source }));

	// forward/reverse を交互にマージ（両方向の代表が残るように）、tuid で重複排除
	const merged: TmMatch[] = [];
	const seen = new Set<string>();
	const maxLength = Math.max(forward.length, reverse.length);
	for (let i = 0; i < maxLength && merged.length < options.maxReferences; i++) {
		for (const match of [forward[i], reverse[i]]) {
			if (!match || seen.has(match.sentenceHash)) {
				continue;
			}
			seen.add(match.sentenceHash);
			merged.push(match);
			if (merged.length >= options.maxReferences) {
				break;
			}
		}
	}
	return merged;
}
