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
	// 同じ本文の章が複数ある場合。どれとどれを結ぶかは前後関係で決めるので、
	// 候補の組み立ては区間が決まってから行う（先に総当たりを作ると区間の数だけ舐め直すことになる）
	const ambiguousGroups: Array<{ entryIdxs: number[]; unitIdxs: number[] }> = [];
	for (const [hash, entryIdxs] of entriesByHash) {
		if (!hash) continue;
		const unitIdxs = unitsByHash.get(hash);
		if (!unitIdxs) continue;
		if (entryIdxs.length === 1 && unitIdxs.length === 1) {
			link(entryIdxs[0], unitIdxs[0]);
		} else {
			ambiguousGroups.push({ entryIdxs, unitIdxs });
		}
	}

	// 2. 確定した組のうち、順序が保たれる最大の部分を「枠」とする。
	//    枠から外れた組（＝移動された章）も対応は保つが、区間の境界には使わない。
	const frame = selectMonotonicAnchors(matched);

	// 3. 区間ごとに、残りを弱い手がかりの順に埋めていく。
	//    区間は互いに素なので、候補の組み立てを区間の中で行えば総量は変わらない。
	const additions: AlignAnchor[] = [];
	const linkInGap = (a: number, b: number): void => {
		link(a, b);
		additions.push({ a, b });
	};
	for (const gap of gapsBetweenAnchors(entries.length, units.length, frame)) {
		// 3a. 同じ本文が複数ある分は、この区間に収まる組み合わせだけを単調性で決める
		const ambiguousInGap: AlignAnchor[] = [];
		for (const group of ambiguousGroups) {
			for (const e of group.entryIdxs) {
				if (e < gap.aStart || e >= gap.aEnd || usedEntries.has(e)) continue;
				for (const u of group.unitIdxs) {
					if (u < gap.bStart || u >= gap.bEnd || usedUnits.has(u)) continue;
					ambiguousInGap.push({ a: e, b: u });
				}
			}
		}
		for (const pick of selectMonotonicAnchors(ambiguousInGap)) {
			if (!usedEntries.has(pick.a) && !usedUnits.has(pick.b)) {
				linkInGap(pick.a, pick.b);
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
				linkInGap(pick.a, pick.b);
			}
		}
	}

	// 4. それでも残ったものは区間内の順序で埋める（見出しごと書き換えられた章がここで拾われる）。
	//    枠は「段階2の枠 ＋ 段階3で区間の中に足した分」。区間は互いに素で段階3の追加も
	//    区間内で単調なので、この和は単調である。ここで単調部分列を取り直すと、
	//    同じ長さの別の解に乗り換えて段階1で確定した錨が枠から落ちうるため、取り直さない。
	const finalFrame = [...frame, ...additions].sort((x, y) => x.a - y.a);
	for (const pair of fillGaps(entries.length, units.length, finalFrame, usedEntries, usedUnits)) {
		link(pair.a, pair.b);
	}

	// 5. 最後の受け皿: 区間に関係なく、余った行と余ったユニットを順序で当てる。
	//
	//    章を移動したうえで編集すると、確定した対応が交差するため区間の枠が崩れ、
	//    余った行と余ったユニットが別々の区間に取り残されることがある。そのまま
	//    「対応なし」で返すと、その訳文ユニットは from を失って新規扱いになり、
	//    次の翻訳で人の訳が上書きされる。**行が余っているのにユニットを対応なしに
	//    しない**ことを、対応の正しさより優先する（誤った from は revise になるが、
	//    from の消失は translate になり、訳文が失われるため）。
	const leftoverEntries: number[] = [];
	for (let e = 0; e < entries.length; e++) {
		if (!usedEntries.has(e)) leftoverEntries.push(e);
	}
	const leftoverUnits: number[] = [];
	for (let u = 0; u < units.length; u++) {
		if (!usedUnits.has(u)) leftoverUnits.push(u);
	}
	for (let i = 0; i < Math.min(leftoverEntries.length, leftoverUnits.length); i++) {
		link(leftoverEntries[i], leftoverUnits[i]);
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
