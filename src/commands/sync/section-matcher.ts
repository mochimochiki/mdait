import { calculateHash } from "../../core/hash/hash-calculator";
import { MdaitMarker } from "../../core/markdown/mdait-marker";
import { MdaitUnit } from "../../core/markdown/mdait-unit";

/**
 * ユニット対応の結果インターフェース（source/targetペアの配列。unmatchedはどちらかがnull）
 */
export type SectionPair = {
	source: MdaitUnit | null;
	target: MdaitUnit | null;
};
export type MatchResult = SectionPair[];

/**
 * ユニット対応処理を行うクラス
 */
export class SectionMatcher {
	/**
	 * ソースと対象のユニット対応付けを行う
	 * @param sourceUnits ソースのユニット配列
	 * @param targetUnits 対象のユニット配列
	 */
	match(sourceUnits: MdaitUnit[], targetUnits: MdaitUnit[]): MatchResult {
		const result: SectionPair[] = [];
		const matchedTargetIndexes = new Set<number>();
		const matchedSourceIndexes = new Set<number>();

		// 1. src一致優先
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

		// 2. 順序ベース推定（srcが付与されていないtargetのみ）
		let sPtr = 0;
		let tPtr = 0;
		while (sPtr < sourceUnits.length || tPtr < targetUnits.length) {
			// 次のマッチ済みsource/targetのindex
			while (sPtr < sourceUnits.length && matchedSourceIndexes.has(sPtr)) sPtr++;
			while (tPtr < targetUnits.length && matchedTargetIndexes.has(tPtr)) tPtr++;

			if (sPtr >= sourceUnits.length && tPtr >= targetUnits.length) break;

			// srcが付与されていないtargetのみを順序ベース対象
			const tIsEligible =
				tPtr < targetUnits.length &&
				!matchedTargetIndexes.has(tPtr) &&
				!targetUnits[tPtr].getSourceHash();
			const sIsEligible = sPtr < sourceUnits.length && !matchedSourceIndexes.has(sPtr);

			if (sIsEligible && tIsEligible) {
				result.push({
					source: sourceUnits[sPtr],
					target: targetUnits[tPtr],
				});
				matchedSourceIndexes.add(sPtr);
				matchedTargetIndexes.add(tPtr);
				sPtr++;
				tPtr++;
			} else if (sIsEligible) {
				// 新規source
				result.push({ source: sourceUnits[sPtr], target: null });
				matchedSourceIndexes.add(sPtr);
				sPtr++;
			} else if (tIsEligible) {
				// 孤立target
				result.push({ source: null, target: targetUnits[tPtr] });
				matchedTargetIndexes.add(tPtr);
				tPtr++;
			} else {
				// どちらも対象外（既にマッチ済み）
				sPtr++;
				tPtr++;
			}
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

		return result;
	}

	/**
	 * 統一ペア配列からターゲットユニットの配列を生成
	 * @param matchResult ユニット対応の結果
	 * @param autoDeleteOrphans 孤立ユニットを自動削除するかどうか
	 */
	createSyncedTargets(matchResult: MatchResult, autoDeleteOrphans = true): MdaitUnit[] {
		const result: MdaitUnit[] = [];
		for (const pair of matchResult) {
			if (pair.source && pair.target) {
				// マッチ
				result.push(pair.target);
			} else if (pair.source && !pair.target) {
				// 新規source
				const sourceHash = calculateHash(pair.source.content);
				const newTarget = MdaitUnit.createEmptyTargetUnit(pair.source, sourceHash);
				result.push(newTarget);
			} else if (!pair.source && pair.target) {
				// 孤立target
				if (!autoDeleteOrphans) {
					if (pair.target.marker) {
						pair.target.marker.need = "verify-deletion";
					} else {
						const hash = calculateHash(pair.target.content);
						pair.target.marker = new MdaitMarker(hash, null, "verify-deletion");
					}
					result.push(pair.target);
				}
				// autoDeleteOrphans=true の場合は何もしない（削除）
			}
		}
		return result;
	}
}
