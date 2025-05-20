import { calculateHash } from "../../core/hash/hash-calculator";
import { MdaitHeader } from "../../core/markdown/mdait-header";
import { MdaitSection } from "../../core/markdown/mdait-section";

/**
 * セクション対応の結果インターフェース（source/targetペアの配列。unmatchedはどちらかがnull）
 */
export type SectionPair = {
	source: MdaitSection | null;
	target: MdaitSection | null;
};
export type MatchResult = SectionPair[];

/**
 * セクション対応処理を行うクラス
 */
export class SectionMatcher {
	/**
	 * ソースと対象のセクション対応付けを行う
	 * @param sourceSections ソースのセクション配列
	 * @param targetSections 対象のセクション配列
	 */
	match(
		sourceSections: MdaitSection[],
		targetSections: MdaitSection[],
	): MatchResult {
		const result: SectionPair[] = [];
		const matchedTargetIndexes = new Set<number>();
		const matchedSourceIndexes = new Set<number>();

		// 1. src一致優先
		for (let sIdx = 0; sIdx < sourceSections.length; sIdx++) {
			const source = sourceSections[sIdx];
			const sourceHash = source.mdaitHeader?.hash;
			if (!sourceHash) continue;
			let found = false;
			for (let tIdx = 0; tIdx < targetSections.length; tIdx++) {
				const target = targetSections[tIdx];
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
		while (sPtr < sourceSections.length || tPtr < targetSections.length) {
			// 次のマッチ済みsource/targetのindex
			while (sPtr < sourceSections.length && matchedSourceIndexes.has(sPtr))
				sPtr++;
			while (tPtr < targetSections.length && matchedTargetIndexes.has(tPtr))
				tPtr++;

			if (sPtr >= sourceSections.length && tPtr >= targetSections.length) break;

			// srcが付与されていないtargetのみを順序ベース対象
			const tIsEligible =
				tPtr < targetSections.length &&
				!matchedTargetIndexes.has(tPtr) &&
				!targetSections[tPtr].getSourceHash();
			const sIsEligible =
				sPtr < sourceSections.length && !matchedSourceIndexes.has(sPtr);

			if (sIsEligible && tIsEligible) {
				result.push({
					source: sourceSections[sPtr],
					target: targetSections[tPtr],
				});
				matchedSourceIndexes.add(sPtr);
				matchedTargetIndexes.add(tPtr);
				sPtr++;
				tPtr++;
			} else if (sIsEligible) {
				// 新規source
				result.push({ source: sourceSections[sPtr], target: null });
				matchedSourceIndexes.add(sPtr);
				sPtr++;
			} else if (tIsEligible) {
				// 孤立target
				result.push({ source: null, target: targetSections[tPtr] });
				matchedTargetIndexes.add(tPtr);
				tPtr++;
			} else {
				// どちらも対象外（既にマッチ済み）
				sPtr++;
				tPtr++;
			}
		}

		// 3. srcがあるのにマッチしなかったtarget（孤立）
		for (let tIdx = 0; tIdx < targetSections.length; tIdx++) {
			if (matchedTargetIndexes.has(tIdx)) continue;
			const target = targetSections[tIdx];
			if (target.getSourceHash()) {
				result.push({ source: null, target });
				matchedTargetIndexes.add(tIdx);
			}
		}

		return result;
	}

	/**
	 * 統一ペア配列からターゲットセクションの配列を生成
	 * @param matchResult セクション対応の結果
	 * @param autoDeleteOrphans 孤立セクションを自動削除するかどうか
	 */
	createSyncedTargets(
		matchResult: MatchResult,
		autoDeleteOrphans = true,
	): MdaitSection[] {
		const result: MdaitSection[] = [];
		for (const pair of matchResult) {
			if (pair.source && pair.target) {
				// マッチ
				result.push(pair.target);
			} else if (pair.source && !pair.target) {
				// 新規source
				const sourceHash = calculateHash(pair.source.content);
				const newTarget = MdaitSection.createEmptyTargetSection(
					pair.source,
					sourceHash,
				);
				result.push(newTarget);
			} else if (!pair.source && pair.target) {
				// 孤立target
				if (!autoDeleteOrphans) {
					if (pair.target.mdaitHeader) {
						pair.target.mdaitHeader.needTag = "verify-deletion";
					} else {
						const hash = calculateHash(pair.target.content);
						pair.target.mdaitHeader = new MdaitHeader(
							hash,
							null,
							"verify-deletion",
						);
					}
					result.push(pair.target);
				}
				// autoDeleteOrphans=true の場合は何もしない（削除）
			}
		}
		return result;
	}
}
