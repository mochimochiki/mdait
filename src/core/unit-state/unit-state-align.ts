/**
 * @file unit-state-align.ts
 *   外部ストア（`.mdait/unit-state`）の行と、いまパースしたユニットを突き合わせる。
 *
 *   1行は「前回 sync した時点でのそのユニットの姿」の写しである（本文の hash・
 *   見出しの hash・見出しレベル）。したがって「行 ↔ ユニット」の対応づけは
 *   「前回の並び ↔ いまの並び」を突き合わせる問題であり、原文と訳文を突き合わせる
 *   `SectionMatcher` と同じ形をしている。共通部分は `core/matching/interval-align` にある。
 *
 *   手がかりは強い順に3つ:
 *     1. 本文の hash が一致する（＝前回から書き換えられていないユニット。確実）
 *     2. 見出しの hash とレベルが一致する（＝本文だけ書き換えられたユニット）
 *     3. 確定した錨と錨のあいだでの順序
 *
 *   何番目かを身元の判定に使わないため、章の挿入・削除・並べ替えで対応がずれない。
 *
 * @module core/unit-state/unit-state-align
 */

import { calculateHash } from "../hash/hash-calculator";
import type { MdaitUnit } from "../markdown/mdait-unit";
import { type AlignAnchor, fillGaps, gapsBetweenAnchors, selectMonotonicAnchors } from "../matching/interval-align";
import type { UnitStateEntry } from "./unit-state-store";

/**
 * 行の並びといまのユニットの並びを突き合わせる。
 *
 * @param entries そのファイルの行（order 昇順）
 * @param units いまパースしたユニット
 * @returns ユニットと同じ長さの配列。`[i]` は units[i] に対応する行（無ければ undefined）
 */
export function alignEntriesToUnits(
	entries: readonly UnitStateEntry[],
	units: readonly MdaitUnit[],
): Array<UnitStateEntry | undefined> {
	const result: Array<UnitStateEntry | undefined> = new Array(units.length).fill(undefined);
	if (entries.length === 0 || units.length === 0) {
		return result;
	}

	const unitHashes = units.map((u) => calculateHash(u.content));
	const unitTitleHashes = units.map((u) => calculateHash(u.title));

	const usedEntries = new Set<number>();
	const usedUnits = new Set<number>();
	const matched: AlignAnchor[] = [];
	const link = (a: number, b: number): void => {
		matched.push({ a, b });
		usedEntries.add(a);
		usedUnits.add(b);
		result[b] = entries[a];
	};

	// 1. 本文の hash が「行にも1つ、ユニットにも1つ」しかない組は、身元が確定している。
	//    順序が入れ替わっていても採用する（章を並べ替えても対応が入れ替わらないのはこのため）。
	const entriesByHash = groupBy(entries.length, (e) => entries[e].hash);
	const unitsByHash = groupBy(units.length, (u) => unitHashes[u]);
	const ambiguous: AlignAnchor[] = [];
	for (const [hash, entryIdxs] of entriesByHash) {
		if (!hash) continue;
		const unitIdxs = unitsByHash.get(hash);
		if (!unitIdxs) continue;
		if (entryIdxs.length === 1 && unitIdxs.length === 1) {
			link(entryIdxs[0], unitIdxs[0]);
		} else {
			// 同じ本文の章が複数ある場合。どれとどれを結ぶかは前後関係で決める（後段）
			for (const e of entryIdxs) {
				for (const u of unitIdxs) {
					ambiguous.push({ a: e, b: u });
				}
			}
		}
	}

	// 2. 確定した組のうち、順序が保たれる最大の部分を「枠」とする。
	//    枠から外れた組（＝移動された章）も対応は保つが、区間の境界には使わない。
	const frame = selectMonotonicAnchors(matched);

	// 3. 区間ごとに、残りを弱い手がかりの順に埋めていく
	for (const gap of gapsBetweenAnchors(entries.length, units.length, frame)) {
		const inGap = (c: AlignAnchor): boolean =>
			c.a >= gap.aStart &&
			c.a < gap.aEnd &&
			c.b >= gap.bStart &&
			c.b < gap.bEnd &&
			!usedEntries.has(c.a) &&
			!usedUnits.has(c.b);

		// 3a. 同じ本文が複数ある分は、この区間に収まる組み合わせだけを単調性で決める
		for (const pick of selectMonotonicAnchors(ambiguous.filter(inGap))) {
			if (!usedEntries.has(pick.a) && !usedUnits.has(pick.b)) {
				link(pick.a, pick.b);
			}
		}

		// 3b. 見出しの hash とレベルの一致（＝本文だけ書き換えられた章）
		const titleCandidates: AlignAnchor[] = [];
		for (let e = gap.aStart; e < gap.aEnd; e++) {
			if (usedEntries.has(e) || !entries[e].titleHash) continue;
			for (let u = gap.bStart; u < gap.bEnd; u++) {
				if (usedUnits.has(u)) continue;
				if (entries[e].titleHash === unitTitleHashes[u] && entries[e].level === units[u].headingLevel) {
					titleCandidates.push({ a: e, b: u });
				}
			}
		}
		for (const pick of selectMonotonicAnchors(titleCandidates)) {
			if (!usedEntries.has(pick.a) && !usedUnits.has(pick.b)) {
				link(pick.a, pick.b);
			}
		}
	}

	// 4. それでも残ったものは区間内の順序で埋める（見出しごと書き換えられた章がここで拾われる）
	const finalFrame = selectMonotonicAnchors(matched);
	for (const pair of fillGaps(entries.length, units.length, finalFrame, usedEntries, usedUnits)) {
		link(pair.a, pair.b);
	}
	return result;
}

/** 添字 0..length-1 を鍵でまとめる */
function groupBy(length: number, keyOf: (index: number) => string): Map<string, number[]> {
	const groups = new Map<string, number[]>();
	for (let i = 0; i < length; i++) {
		const key = keyOf(i);
		const list = groups.get(key);
		if (list) {
			list.push(i);
		} else {
			groups.set(key, [i]);
		}
	}
	return groups;
}
