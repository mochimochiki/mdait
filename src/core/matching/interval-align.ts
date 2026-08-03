/**
 * @file interval-align.ts
 *   2つの並びを突き合わせる汎用ロジック。
 *
 *   mdait には「2つのユニット列を対応づける」場面が2つある。
 *
 *   1. 原文の列 ↔ 訳文の列（`SectionMatcher`。確実な鍵は「訳文の from == 原文の hash」）
 *   2. 前回の状態の列 ↔ いまのユニット列（external マーカーの attach。確実な鍵は「保存済み hash == いまの hash」）
 *
 *   どちらも形は同じで、「確実な鍵で錨を打つ → 錨と錨のあいだの区間に割る →
 *   区間内を順序で埋める → 余りを新規／消失とする」である。鍵の取り出し方と
 *   区間内の手がかりだけが違う。ここにはその共通部分だけを置く。
 *
 *   添字だけを扱い、ユニットの型には依存しない。
 *
 * @module core/matching/interval-align
 */

/** 対応づけの候補・確定した錨（a=左の並びの添字, b=右の並びの添字） */
export interface AlignAnchor {
	a: number;
	b: number;
}

/** 突き合わせ結果の1組。片側が null なら対応相手がいない */
export interface AlignedPair {
	a: number | null;
	b: number | null;
}

/** 候補の総当たりを打ち切る上限（同一内容が大量にある病的な文書での暴走を防ぐ） */
const MAX_CANDIDATES = 20000;

/**
 * 候補の中から「両側とも順序が保たれる」最大の組み合わせを選ぶ。
 *
 * 同じ鍵を持つ要素が複数あると候補は多対多になる（例: まったく同じ本文の章が2つある文書）。
 * そのうち順序を崩さない最大の組を選ぶことで、「どちらの重複が消えたのか」が
 * 前後の確定した錨から自動的に決まる。マーカーを本文に埋め込む方式が
 * 位置で正しく解けるのと同じ答えに行き着く。
 *
 * @param candidates 鍵が一致する組の候補（順不同でよい）
 * @returns a 昇順に並んだ、a も b も狭義単調増加な最大の部分集合
 */
export function selectMonotonicAnchors(candidates: readonly AlignAnchor[]): AlignAnchor[] {
	if (candidates.length === 0) {
		return [];
	}
	if (candidates.length > MAX_CANDIDATES) {
		// 病的な件数のときは総当たりを諦め、各 a に対する最小の b を順に拾う近似に落とす
		return approximateAnchors(candidates);
	}

	// a 昇順・b 降順に並べると、b の狭義増加部分列を取るだけで
	// 「a も b も重複せず単調」な最大の組み合わせになる（同じ a の中では b が減るため
	// 増加部分列に2つ以上入らない）。
	const sorted = [...candidates].sort((x, y) => (x.a !== y.a ? x.a - y.a : y.b - x.b));

	// patience sorting による最長増加部分列（O(n log n)）。tails[k] は
	// 「長さ k+1 の増加部分列の末尾として最小の b」を持つ sorted 上の添字。
	const tails: number[] = [];
	const prev: number[] = new Array(sorted.length).fill(-1);
	for (let i = 0; i < sorted.length; i++) {
		const b = sorted[i].b;
		let lo = 0;
		let hi = tails.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (sorted[tails[mid]].b < b) {
				lo = mid + 1;
			} else {
				hi = mid;
			}
		}
		prev[i] = lo > 0 ? tails[lo - 1] : -1;
		tails[lo] = i;
	}

	const picked: AlignAnchor[] = [];
	let cursor = tails.length > 0 ? tails[tails.length - 1] : -1;
	while (cursor >= 0) {
		picked.push(sorted[cursor]);
		cursor = prev[cursor];
	}
	picked.reverse();
	return picked;
}

/** 候補が多すぎる場合の近似。a 昇順に走査し、直前より大きい b を貪欲に拾う */
function approximateAnchors(candidates: readonly AlignAnchor[]): AlignAnchor[] {
	const sorted = [...candidates].sort((x, y) => (x.a !== y.a ? x.a - y.a : x.b - y.b));
	const picked: AlignAnchor[] = [];
	let lastA = -1;
	let lastB = -1;
	for (const c of sorted) {
		if (c.a > lastA && c.b > lastB) {
			picked.push(c);
			lastA = c.a;
			lastB = c.b;
		}
	}
	return picked;
}

/**
 * 錨で区切られた区間の一覧を返す。錨そのものは含まない。
 *
 * 返す区間は必ず互いに素で、a も b も昇順に並ぶ。錨が単調でない場合
 * （並べ替えられた要素をそのまま渡した場合など）は、順序を巻き戻す錨を
 * 区切りとして使わずに読み飛ばす。区間が重なると `fillGaps` が同じ添字を
 * 二度使ってしまうため、ここで必ず単調にしておく。
 *
 * @param lenA 左の並びの長さ
 * @param lenB 右の並びの長さ
 * @param anchors 錨（`selectMonotonicAnchors` の出力を想定。単調でなくても壊れない）
 */
export function normalizeAnchors(anchors: readonly AlignAnchor[]): AlignAnchor[] {
	const sorted = [...anchors].sort((x, y) => (x.a !== y.a ? x.a - y.a : x.b - y.b));
	const kept: AlignAnchor[] = [];
	let lastA = -1;
	let lastB = -1;
	for (const anchor of sorted) {
		// 区切りに使えるのは、両側とも直前の錨より後ろにある錨だけ
		if (anchor.a <= lastA || anchor.b <= lastB) {
			continue;
		}
		kept.push(anchor);
		lastA = anchor.a;
		lastB = anchor.b;
	}
	return kept;
}

export function gapsBetweenAnchors(
	lenA: number,
	lenB: number,
	anchors: readonly AlignAnchor[],
): Array<{ aStart: number; aEnd: number; bStart: number; bEnd: number }> {
	const gaps: Array<{ aStart: number; aEnd: number; bStart: number; bEnd: number }> = [];
	let aCursor = 0;
	let bCursor = 0;
	for (const anchor of normalizeAnchors(anchors)) {
		if (anchor.a > aCursor || anchor.b > bCursor) {
			gaps.push({ aStart: aCursor, aEnd: anchor.a, bStart: bCursor, bEnd: anchor.b });
		}
		aCursor = anchor.a + 1;
		bCursor = anchor.b + 1;
	}
	if (aCursor < lenA || bCursor < lenB) {
		gaps.push({ aStart: aCursor, aEnd: lenA, bStart: bCursor, bEnd: lenB });
	}
	return gaps;
}

/**
 * 錨を確定として、区間内の残りを順序で埋めた完全な対応表を返す。
 *
 * 区間内に残るのは「書き換えられた要素」「新しく増えた要素」「消えた要素」だけなので、
 * 多くの区間は1対1に定まる。数が合わない分は、余った側を片側 null の組として返す。
 *
 * @param lenA 左の並びの長さ
 * @param lenB 右の並びの長さ
 * @param anchors 確定した錨（a 昇順・単調であること）
 * @returns a の昇順（a が null の組は対応する b の位置に現れる）
 */
export function alignByAnchors(lenA: number, lenB: number, anchors: readonly AlignAnchor[]): AlignedPair[] {
	// 単調でない錨は区切りに使えない（区間が重なり、同じ添字を二度使ってしまう）。
	// 落ちた錨の添字は未使用として扱い、区間の順序埋めに回す。
	const normalized = normalizeAnchors(anchors);
	const usedA = new Set<number>(normalized.map((x) => x.a));
	const usedB = new Set<number>(normalized.map((x) => x.b));
	const filled = fillGaps(lenA, lenB, normalized, usedA, usedB);
	for (const pair of filled) {
		usedA.add(pair.a);
		usedB.add(pair.b);
	}

	const bByA = new Map<number, number>();
	for (const pair of [...normalized, ...filled]) {
		bByA.set(pair.a, pair.b);
	}

	// a 昇順に並べ、相手のいない b は「直前に確定した b」の後ろに差し込む
	const pairs: AlignedPair[] = [];
	let bCursor = 0;
	const emitOrphanBUntil = (limit: number): void => {
		while (bCursor < limit) {
			if (!usedB.has(bCursor)) {
				pairs.push({ a: null, b: bCursor });
			}
			bCursor++;
		}
	};
	for (let a = 0; a < lenA; a++) {
		const b = bByA.get(a);
		if (b === undefined) {
			pairs.push({ a, b: null });
			continue;
		}
		emitOrphanBUntil(b);
		pairs.push({ a, b });
		bCursor = b + 1;
	}
	emitOrphanBUntil(lenB);
	return pairs;
}

/**
 * 錨で区切られた区間の中に残った要素を、順序で対応づける。
 *
 * すでに他の手がかりで対応がついた添字（`usedA` / `usedB`）は飛ばす。
 * 並べ替えのように錨の枠から外れた対応も、使用済みとして渡せば二重取りにならない。
 *
 * @returns 新たに対応づいた組だけ（渡した錨は含まない）
 */
export function fillGaps(
	lenA: number,
	lenB: number,
	frame: readonly AlignAnchor[],
	usedA: ReadonlySet<number> = new Set(),
	usedB: ReadonlySet<number> = new Set(),
): AlignAnchor[] {
	const filled: AlignAnchor[] = [];
	for (const gap of gapsBetweenAnchors(lenA, lenB, frame)) {
		let a = gap.aStart;
		let b = gap.bStart;
		for (;;) {
			while (a < gap.aEnd && usedA.has(a)) a++;
			while (b < gap.bEnd && usedB.has(b)) b++;
			if (a >= gap.aEnd || b >= gap.bEnd) break;
			filled.push({ a, b });
			a++;
			b++;
		}
	}
	return filled;
}
