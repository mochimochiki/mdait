import { calculateHash } from "../../core/hash/hash-calculator";
import { MdaitMarker } from "../../core/markdown/mdait-marker";
import { MdaitUnit } from "../../core/markdown/mdait-unit";
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
	 * ソースと対象のユニット対応付けを行う
	 * @param sourceUnits ソースのユニット配列
	 * @param targetUnits 対象のユニット配列
	 * @param independentTargets 独立ユニット（ファイルに永続化されたマーカーを持つパススルー対象）の集合
	 */
	match(
		sourceUnits: MdaitUnit[],
		targetUnits: MdaitUnit[],
		independentTargets?: ReadonlySet<MdaitUnit>,
	): MatchResult {
		const result: SectionPair[] = [];
		const matchedTargetIndexes = new Set<number>();
		const matchedSourceIndexes = new Set<number>();

		// 0. 独立ユニット（need:isolate / fromなしの永続マーカー）は対応付け対象から除外し、
		//    孤立ターゲットとしてパススルーする（sourceと誤対応させない）
		const independentTargetIndexes = new Set<number>();
		for (let tIdx = 0; tIdx < targetUnits.length; tIdx++) {
			if (independentTargets?.has(targetUnits[tIdx])) {
				independentTargetIndexes.add(tIdx);
				matchedTargetIndexes.add(tIdx);
			}
		}

		// 1. targetのfromとsourceのhashが一致する組をマッチ済みペアとして対応付け
		for (let sIdx = 0; sIdx < sourceUnits.length; sIdx++) {
			const source = sourceUnits[sIdx];
			const sourceHash = source.marker?.hash;
			if (!sourceHash) continue;
			let found = false;
			for (let tIdx = 0; tIdx < targetUnits.length; tIdx++) {
				const target = targetUnits[tIdx];
				if (matchedTargetIndexes.has(tIdx)) continue;
				const targetSrc = target.getSourceHash();
				if (targetSrc && targetSrc === sourceHash) {
					result.push({ source, target });
					matchedTargetIndexes.add(tIdx);
					matchedSourceIndexes.add(sIdx);
					found = true;
					break;
				}
			}
			if (!found) {
				// src一致しなかったsourceは後で順序ベース推定
				// ここでは何もしない
			}
		}

		// 1.5. need:isolate の source は from 一致（Phase 1）でのみマッチ可。
		//      順序ベース推定（Phase 2）の対象から外し、未マッチのまま {source, target:null}
		//      としてペアに含める（hash 更新のため）
		const unmatchedIsolateSourceIndexes: number[] = [];
		for (let sIdx = 0; sIdx < sourceUnits.length; sIdx++) {
			if (matchedSourceIndexes.has(sIdx)) continue;
			if (sourceUnits[sIdx].marker?.need === "isolate") {
				unmatchedIsolateSourceIndexes.push(sIdx);
				matchedSourceIndexes.add(sIdx);
			}
		}

		// 2. マッチ済みユニット間ごとに区間分割し、順序ベースで対応付け
		let lastMatchedSource = -1;
		let lastMatchedTarget = -1;
		const matchedPairs: Array<{ s: number; t: number }> = [];
		for (let i = 0; i < result.length; i++) {
			const source = result[i].source;
			const target = result[i].target;
			const sIdx = source ? sourceUnits.indexOf(source) : -1;
			const tIdx = target ? targetUnits.indexOf(target) : -1;
			matchedPairs.push({ s: sIdx, t: tIdx });
		}
		matchedPairs.push({ s: sourceUnits.length, t: targetUnits.length }); // 末尾区間用

		for (let k = 0; k < matchedPairs.length; k++) {
			const s_Start = lastMatchedSource + 1;
			const s_End = matchedPairs[k].s;
			const t_Start = lastMatchedTarget + 1;
			const t_End = matchedPairs[k].t;

			// 区間内の未マッチsource/targetを順序ベースで対応付け
			let s_index = s_Start;
			let t_index = t_Start;
			while (s_index < s_End || t_index < t_End) {
				while (s_index < s_End && matchedSourceIndexes.has(s_index)) s_index++;
				while (t_index < t_End && matchedTargetIndexes.has(t_index)) t_index++;
				if (s_index >= s_End && t_index >= t_End) break;
				const s_IsUnMatched = s_index < s_End && !matchedSourceIndexes.has(s_index);
				const t_IsUnMatched =
					t_index < t_End && !matchedTargetIndexes.has(t_index) && !targetUnits[t_index].getSourceHash();
				if (s_IsUnMatched && t_IsUnMatched) {
					// 両方未マッチの場合はペアとして対応付け（あまり起きないはず）
					result.push({ source: sourceUnits[s_index], target: targetUnits[t_index] });
					matchedSourceIndexes.add(s_index);
					matchedTargetIndexes.add(t_index);
					s_index++;
					t_index++;
				} else if (s_IsUnMatched) {
					// sourceに対応するtargetがない→新規追加
					result.push({ source: sourceUnits[s_index], target: null });
					matchedSourceIndexes.add(s_index);
					s_index++;
				} else if (t_IsUnMatched) {
					// targetに対応するsourceがない→削除（候補）
					result.push({ source: null, target: targetUnits[t_index] });
					matchedTargetIndexes.add(t_index);
					t_index++;
				} else {
					s_index++;
					t_index++;
				}
			}
			lastMatchedSource = s_End;
			lastMatchedTarget = t_End;
		}

		// 3. srcがあるのにマッチしなかったtarget（孤立）
		for (let tIdx = 0; tIdx < targetUnits.length; tIdx++) {
			if (matchedTargetIndexes.has(tIdx)) continue;
			const target = targetUnits[tIdx];
			if (target.getSourceHash()) {
				result.push({ source: null, target });
				matchedTargetIndexes.add(tIdx);
			}
		}

		// 3b. 独立ユニットを孤立ターゲットとしてパススルー
		for (const tIdx of independentTargetIndexes) {
			result.push({ source: null, target: targetUnits[tIdx] });
		}

		// 3c. Phase 1 でマッチしなかった isolate source（hash 更新のためペアに含める）
		for (const sIdx of unmatchedIsolateSourceIndexes) {
			result.push({ source: sourceUnits[sIdx], target: null });
		}

		// source基準でソート
		const ordered: SectionPair[] = [];
		for (let sIdx = 0; sIdx < sourceUnits.length; sIdx++) {
			const pair = result.find((p) => p.source === sourceUnits[sIdx]);
			if (pair) ordered.push(pair);
		}
		for (let tIdx = 0; tIdx < targetUnits.length; tIdx++) {
			const pair = result.find((p) => !p.source && p.target === targetUnits[tIdx]);
			if (pair) ordered.push(pair);
		}
		return ordered;
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
		return { units: result, orphanDeleted, orphanVerified, orphanKept, orphanReviewed };
	}
}
