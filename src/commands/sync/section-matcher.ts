import { calculateHash } from "../../core/hash/hash-calculator";
import { MdaitMarker } from "../../core/markdown/mdait-marker";
import { MdaitUnit } from "../../core/markdown/mdait-unit";
import {
	type AlignAnchor,
	fillGaps,
	gapsBetweenAnchors,
	selectMonotonicAnchors,
} from "../../core/matching/interval-align";
import type { OrphanTargetPolicy } from "../../infra/config/configuration";

/**
 * ユニット対応の結果インターフェース（source/targetペアの配列。unmatchedはどちらかがnull）
 */
export type SectionPair = {
	source: MdaitUnit | null;
	target: MdaitUnit | null;
};
export type MatchResult = SectionPair[];

/**
 * createSyncedTargetsの結果（同期後ユニットと孤立ターゲット処理の内訳）
 */
export interface SyncedTargetsResult {
	units: MdaitUnit[];
	/** このsyncで削除した孤立ターゲット数 */
	orphanDeleted: number;
	/** 削除した孤立ターゲットの見出し（何が消えたかを人に伝えるため。本文は残さない） */
	orphanDeletedTitles: string[];
	/** need:verify-deletion を付与した（または維持した）孤立ターゲット数 */
	orphanVerified: number;
	/** 独立ユニット（need:isolate / fromなしの永続マーカー）としてパススルー保持した数 */
	orphanKept: number;
	/** マーカーなしの孤立ターゲットに need:review を一次受け付与した数 */
	orphanReviewed: number;
}

/**
 * ユニット対応処理を行うクラス
 */
export class SectionMatcher {
	/**
	 * ソースと対象のユニット対応付けを行う。
	 *
	 * 形は external の attach（`core/unit-state/unit-state-align.ts`）と同じで、共通部分は
	 * `core/matching/interval-align` にある — 確実な鍵で錨を打ち、順序の保たれる錨だけを枠にして
	 * 区間に割り、区間の中を順序で埋める。原文と訳文の突き合わせに固有なのは次の3点である。
	 *
	 * - 確実な鍵は「訳文の from == 原文の hash」。**錨は区間に関係なく採る**ので、章を
	 *   並べ替えても対応は入れ替わらない（枠から外れた錨は区間の境界に使わないだけ）
	 * - 区間を順序で埋めるときに使える訳文は **from を持たないものだけ**。from を持つのに
	 *   錨にならなかった訳文は、原文を失った訳文（dangling）であり、別の原文に付け替えない
	 * - 独立ユニットと、from で結ばれなかった `need:isolate` の原文は順序で埋める対象にしない
	 *
	 * 結果は `orderPairs` の規約で並ぶ（原文の順。相手のいない訳文は元の位置に差し込む）。
	 *
	 * @param sourceUnits ソースのユニット配列
	 * @param targetUnits 対象のユニット配列
	 * @param independentTargets 独立ユニット（ファイルに永続化されたマーカーを持つパススルー対象）の集合
	 */
	match(sourceUnits: MdaitUnit[], targetUnits: MdaitUnit[], independentTargets?: ReadonlySet<MdaitUnit>): MatchResult {
		const targetOf = new Map<number, number>();
		const usedSources = new Set<number>();
		const usedTargets = new Set<number>();
		const link = (s: number, t: number): void => {
			targetOf.set(s, t);
			usedSources.add(s);
			usedTargets.add(t);
		};

		// 0. 独立ユニット（need:isolate / fromなしの永続マーカー）は対応付け対象から除外し、
		//    孤立ターゲットとしてパススルーする（sourceと誤対応させない）
		const independentIndexes = new Set<number>();
		for (let t = 0; t < targetUnits.length; t++) {
			if (independentTargets?.has(targetUnits[t])) {
				independentIndexes.add(t);
			}
		}

		// 1. 訳文の from と原文の hash が「原文にも1つ、訳文にも1つ」しかない組は身元が確定している。
		//    順序が入れ替わっていても採用する
		const sourcesByHash = groupIndexes(sourceUnits.length, (s) => sourceUnits[s].marker?.hash ?? "");
		const targetsByFrom = groupIndexes(targetUnits.length, (t) =>
			independentIndexes.has(t) ? "" : (targetUnits[t].getSourceHash() ?? ""),
		);
		const anchors: AlignAnchor[] = [];
		// 同じ本文の原文が複数ある分。どれとどれを結ぶかは前後の確定した錨との順序で決める
		const ambiguousGroups: Array<{ sources: number[]; targets: number[] }> = [];
		for (const [hash, sources] of sourcesByHash) {
			if (!hash) continue;
			const targets = targetsByFrom.get(hash);
			if (!targets) continue;
			if (sources.length === 1 && targets.length === 1) {
				link(sources[0], targets[0]);
				anchors.push({ a: sources[0], b: targets[0] });
			} else {
				ambiguousGroups.push({ sources, targets });
			}
		}

		// 2. 確定した組のうち、順序が保たれる最大の部分を枠にする。
		//    枠から外れた組（＝並べ替えられた章）も対応は保つが、区間の境界には使わない
		const frame = selectMonotonicAnchors(anchors);

		// 3. 同じ本文の原文が複数ある分は、区間に収まる組み合わせだけを単調性で決める
		const additions: AlignAnchor[] = [];
		for (const gap of gapsBetweenAnchors(sourceUnits.length, targetUnits.length, frame)) {
			const candidates: AlignAnchor[] = [];
			for (const group of ambiguousGroups) {
				for (const s of group.sources) {
					if (s < gap.aStart || s >= gap.aEnd || usedSources.has(s)) continue;
					for (const t of group.targets) {
						if (t < gap.bStart || t >= gap.bEnd || usedTargets.has(t)) continue;
						candidates.push({ a: s, b: t });
					}
				}
			}
			for (const pick of selectMonotonicAnchors(candidates)) {
				if (!usedSources.has(pick.a) && !usedTargets.has(pick.b)) {
					link(pick.a, pick.b);
					additions.push(pick);
				}
			}
		}
		// 区間をまたいで余った同じ本文の組は、順に当てる。本文がまったく同じ原文どうしは
		// 入れ替えても意味が変わらないので、どれに当てても等価である。from の一致は順序より
		// 強い手がかりなので、順序で埋める段より先に済ませる
		for (const group of ambiguousGroups) {
			const freeSources = group.sources.filter((s) => !usedSources.has(s));
			const freeTargets = group.targets.filter((t) => !usedTargets.has(t));
			for (let i = 0; i < Math.min(freeSources.length, freeTargets.length); i++) {
				link(freeSources[i], freeTargets[i]);
			}
		}

		// 4. 残りを区間内の順序で埋める。使えない側は使用済みと同じ扱いで渡す —
		//    from で結ばれなかった need:isolate の原文（from 一致でしか結ばない）と、
		//    独立ユニット・from を持つ訳文（原文を失った訳文を別の原文へ付け替えない）
		const unavailableSources = new Set(usedSources);
		for (let s = 0; s < sourceUnits.length; s++) {
			if (!usedSources.has(s) && sourceUnits[s].marker?.need === "isolate") {
				unavailableSources.add(s);
			}
		}
		const unavailableTargets = new Set(usedTargets);
		for (let t = 0; t < targetUnits.length; t++) {
			if (independentIndexes.has(t) || targetUnits[t].getSourceHash()) {
				unavailableTargets.add(t);
			}
		}
		const finalFrame = [...frame, ...additions].sort((x, y) => x.a - y.a);
		for (const pair of fillGaps(
			sourceUnits.length,
			targetUnits.length,
			finalFrame,
			unavailableSources,
			unavailableTargets,
		)) {
			link(pair.a, pair.b);
		}

		// 5. 相手のいない原文は新規（isolate は hash 更新のためだけに載る）、相手のいない訳文は孤立
		const pairs: SectionPair[] = sourceUnits.map((source, s) => {
			const t = targetOf.get(s);
			return { source, target: t === undefined ? null : targetUnits[t] };
		});
		for (let t = 0; t < targetUnits.length; t++) {
			if (!usedTargets.has(t)) {
				pairs.push({ source: null, target: targetUnits[t] });
			}
		}
		return orderPairs(pairs, sourceUnits, targetUnits);
	}

	/**
	 * 統一ペア配列からターゲットユニットの配列を生成
	 * @param matchResult ユニット対応の結果
	 * @param orphanPolicy 孤立ターゲットの処理ポリシー（delete/verify）
	 * @param independentTargets 独立ユニット（ポリシーに関わらず不変で保持する）の集合
	 */
	createSyncedTargets(
		matchResult: MatchResult,
		orphanPolicy: OrphanTargetPolicy = "delete",
		independentTargets?: ReadonlySet<MdaitUnit>,
	): SyncedTargetsResult {
		const result: MdaitUnit[] = [];
		let orphanDeleted = 0;
		const orphanDeletedTitles: string[] = [];
		let orphanVerified = 0;
		let orphanKept = 0;
		let orphanReviewed = 0;
		for (const pair of matchResult) {
			if (pair.source && pair.target) {
				// マッチ
				result.push(pair.target);
			} else if (pair.source && !pair.target) {
				// 新規source。need:isolate は下流に出さない（伝播停止）
				if (pair.source.marker?.need === "isolate") {
					continue;
				}
				const sourceHash = calculateHash(pair.source.content);
				const newTarget = MdaitUnit.createEmptyTargetUnit(pair.source, sourceHash);
				result.push(newTarget);
			} else if (!pair.source && pair.target) {
				// 孤立target
				// 独立ユニットと need:isolate はポリシーに関わらず不変で保持する（パススルー・冪等。
				// from付きisolateは通常Phase 1でペア維持されるが、原文消失時もここで保護される）
				if (independentTargets?.has(pair.target) || pair.target.marker?.need === "isolate") {
					result.push(pair.target);
					orphanKept++;
					continue;
				}
				const marker = pair.target.marker;
				if (marker?.from || marker?.need === "verify-deletion") {
					// dangling（管理下にあったが原文を失った）: ポリシーに従う
					if (orphanPolicy === "delete") {
						// 何もしない（削除）
						orphanDeleted++;
						orphanDeletedTitles.push(pair.target.title || pair.target.marker?.hash || "");
					} else {
						marker.setNeed("verify-deletion");
						result.push(pair.target);
						orphanVerified++;
					}
				} else {
					// マーカーなしで書かれた管理外コンテンツ（素hashはensureMdaitMarkerHashが合成済み）:
					// 削除も翻訳も決めつけず need:review の一次受けで人間の判断に委ねる。
					// 次回syncでは「永続化されたfromなしneed:review」＝独立ユニット扱いになり冪等
					if (marker) {
						marker.setNeed("review");
					} else {
						pair.target.marker = new MdaitMarker(calculateHash(pair.target.content), null, "review");
					}
					result.push(pair.target);
					orphanReviewed++;
				}
			}
		}
		return { units: result, orphanDeleted, orphanDeletedTitles, orphanVerified, orphanKept, orphanReviewed };
	}
}

/**
 * ペアを訳文ファイルに書き出す順に並べる。`match()` と AI アライン（`align-result.ts`）が
 * 共有する順序の規約である。
 *
 * 原文を持つペアは原文の順に並べる。相手のいない訳文（独立ユニット・孤立した訳文）は、
 * **訳文の中で元あった位置**に差し込む — 自分より後ろにあった訳文を持つペアの直前である。
 * 末尾へ寄せると、訳文の途中に人が書き足した章が sync のたびにファイルの末尾へ動く。
 *
 * 位置の手がかりにするのは、原文の順に見て訳文の位置も増えていくペアだけである。
 * 並べ替えられた章（訳文の位置が戻るペア）を手がかりにすると、差し込む位置が前へ飛ぶ。
 */
export function orderPairs(
	pairs: readonly SectionPair[],
	sourceUnits: readonly MdaitUnit[],
	targetUnits: readonly MdaitUnit[],
): MatchResult {
	const targetIndex = new Map<MdaitUnit, number>();
	targetUnits.forEach((unit, index) => targetIndex.set(unit, index));
	const bySource = new Map<MdaitUnit, SectionPair>();
	const orphans: Array<{ index: number; pair: SectionPair }> = [];
	for (const pair of pairs) {
		if (pair.source) {
			bySource.set(pair.source, pair);
		} else if (pair.target) {
			orphans.push({ index: targetIndex.get(pair.target) ?? Number.MAX_SAFE_INTEGER, pair });
		}
	}
	orphans.sort((x, y) => x.index - y.index);

	// 手がかりにするのは、順序の保たれる組の最大の部分（`selectMonotonicAnchors`）だけ。
	// 「直前より後ろなら採る」と貪欲に進めると、先頭の並べ替えられた章が位置を決めてしまう
	// （原文 [a,b,c]・訳文 [b,own,c,a] で own が a より前へ飛ぶ）
	const linked: AlignAnchor[] = [];
	sourceUnits.forEach((source, s) => {
		const target = bySource.get(source)?.target;
		const t = target ? targetIndex.get(target) : undefined;
		if (t !== undefined) {
			linked.push({ a: s, b: t });
		}
	});
	const insertionAnchors = new Map(selectMonotonicAnchors(linked).map((anchor) => [anchor.a, anchor.b]));

	const ordered: SectionPair[] = [];
	let nextOrphan = 0;
	sourceUnits.forEach((source, s) => {
		const pair = bySource.get(source);
		if (!pair) return;
		const t = insertionAnchors.get(s);
		if (t !== undefined) {
			while (nextOrphan < orphans.length && orphans[nextOrphan].index < t) {
				ordered.push(orphans[nextOrphan++].pair);
			}
		}
		ordered.push(pair);
	});
	while (nextOrphan < orphans.length) {
		ordered.push(orphans[nextOrphan++].pair);
	}
	return ordered;
}

/** 添字 0..length-1 を鍵でまとめる */
function groupIndexes(length: number, keyOf: (index: number) => string): Map<string, number[]> {
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
