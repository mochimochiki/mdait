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
			const sStart = lastMatchedSource + 1;
			const sEnd = matchedPairs[k].s;
			const tStart = lastMatchedTarget + 1;
			const tEnd = matchedPairs[k].t;

			// 区間内の未マッチsource/targetを順序ベースで対応付け
			let sPtr = sStart;
			let tPtr = tStart;
			while (sPtr < sEnd || tPtr < tEnd) {
				while (sPtr < sEnd && matchedSourceIndexes.has(sPtr)) sPtr++;
				while (tPtr < tEnd && matchedTargetIndexes.has(tPtr)) tPtr++;
				if (sPtr >= sEnd && tPtr >= tEnd) break;
				const sIsEligible = sPtr < sEnd && !matchedSourceIndexes.has(sPtr);
				const tIsEligible = tPtr < tEnd && !matchedTargetIndexes.has(tPtr) && !targetUnits[tPtr].getSourceHash();
				if (sIsEligible && tIsEligible) {
					result.push({ source: sourceUnits[sPtr], target: targetUnits[tPtr] });
					matchedSourceIndexes.add(sPtr);
					matchedTargetIndexes.add(tPtr);
					sPtr++;
					tPtr++;
				} else if (sIsEligible) {
					result.push({ source: sourceUnits[sPtr], target: null });
					matchedSourceIndexes.add(sPtr);
					sPtr++;
				} else if (tIsEligible) {
					result.push({ source: null, target: targetUnits[tPtr] });
					matchedTargetIndexes.add(tPtr);
					tPtr++;
				} else {
					sPtr++;
					tPtr++;
				}
			}
			lastMatchedSource = sEnd;
			lastMatchedTarget = tEnd;
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
