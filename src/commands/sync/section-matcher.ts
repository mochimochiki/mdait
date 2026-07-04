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
	/** need:keep で保持した孤立ターゲット数（既存keepのパススルー含む） */
	orphanKept: number;
	/** backfill対象として処理した孤立ターゲット（原文側プレースホルダの生成対象） */
	backfillTargets: MdaitUnit[];
}

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

		// 0. need:keep のターゲット（独自ユニット）は対応付け対象から除外し、
		//    孤立ターゲットとしてパススルーする（sourceと誤対応させない）
		const keepTargetIndexes = new Set<number>();
		for (let tIdx = 0; tIdx < targetUnits.length; tIdx++) {
			if (targetUnits[tIdx].marker?.need === "keep") {
				keepTargetIndexes.add(tIdx);
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

		// 3b. need:keep のターゲットを孤立ターゲットとしてパススルー
		for (const tIdx of keepTargetIndexes) {
			result.push({ source: null, target: targetUnits[tIdx] });
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
	 * @param orphanPolicy 孤立ターゲットの処理ポリシー（delete/verify/keep）
	 */
	createSyncedTargets(
		matchResult: MatchResult,
		orphanPolicy: OrphanTargetPolicy = "delete",
	): SyncedTargetsResult {
		const result: MdaitUnit[] = [];
		let orphanDeleted = 0;
		let orphanVerified = 0;
		let orphanKept = 0;
		const backfillTargets: MdaitUnit[] = [];
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
				// 既に need:keep のユニットはポリシーに関わらず不変で保持する（恒久保持の保証）
				if (pair.target.marker?.need === "keep") {
					result.push(pair.target);
					orphanKept++;
					continue;
				}
				if (orphanPolicy === "delete") {
					// 何もしない（削除）
					orphanDeleted++;
				} else if (orphanPolicy === "backfill") {
					// backfill: 訳文ユニットを保持し、from を自ユニットのハッシュにする。
					// 原文側プレースホルダ（同一内容＝同一ハッシュ）の生成は呼び出し側が
					// insertBackfillPlaceholders で行い、fromリンクが即座に成立する。
					const hash = pair.target.marker?.hash ?? calculateHash(pair.target.content);
					pair.target.marker = new MdaitMarker(hash, hash, null);
					result.push(pair.target);
					backfillTargets.push(pair.target);
				} else if (orphanPolicy === "verify") {
					if (pair.target.marker) {
						pair.target.marker.need = "verify-deletion";
					} else {
						const hash = calculateHash(pair.target.content);
						pair.target.marker = new MdaitMarker(hash, null, "verify-deletion");
					}
					result.push(pair.target);
					orphanVerified++;
				} else {
					// keep: need:keep を付与して恒久保持（独自ユニット。from は持たない）
					const hash = pair.target.marker?.hash ?? calculateHash(pair.target.content);
					pair.target.marker = new MdaitMarker(hash, null, "keep");
					result.push(pair.target);
					orphanKept++;
				}
			}
		}
		return { units: result, orphanDeleted, orphanVerified, orphanKept, backfillTargets };
	}

	/**
	 * backfill対象の孤立ターゲットに対応する原文側プレースホルダユニットを生成し、
	 * sourceUnits の推定位置に挿入する。
	 *
	 * - プレースホルダの内容はターゲット本文をそのまま置く（ハッシュが一致するため
	 *   `target.from = placeholder.hash` の通常のfromリンクが即座に成立する）
	 * - マーカーは `<!-- mdait {hash} need:backfill -->`（fromなしの正規ソースユニット）
	 * - 挿入位置: ターゲット順で直前にある「対応済みターゲット」に対応するソースユニットの直後。
	 *   先頭の孤立ターゲットは先頭に挿入する。
	 *
	 * @param sourceUnits 原文側ユニット配列（この配列を直接変更する）
	 * @param targetUnits ターゲット側ユニット配列（位置推定用の元順序）
	 * @param matchResult 対応付け結果
	 * @param backfillTargets backfill対象の孤立ターゲット
	 * @returns 挿入したプレースホルダ数
	 */
	insertBackfillPlaceholders(
		sourceUnits: MdaitUnit[],
		targetUnits: readonly MdaitUnit[],
		matchResult: MatchResult,
		backfillTargets: readonly MdaitUnit[],
	): number {
		let inserted = 0;
		for (const target of backfillTargets) {
			const hash = target.marker?.hash ?? calculateHash(target.content);

			// 既に同一ハッシュのソースユニットが存在する場合はスキップ（冪等性）
			if (sourceUnits.some((u) => u.marker?.hash === hash)) {
				continue;
			}

			const placeholder = new MdaitUnit(
				new MdaitMarker(hash, null, "backfill"),
				target.title,
				target.headingLevel,
				target.content,
				target.startLine,
				target.endLine,
			);

			// 挿入位置の推定: ターゲット順で直前の対応済みターゲットのソース位置の直後
			let insertIndex = 0;
			const tIdx = targetUnits.indexOf(target);
			for (let i = tIdx - 1; i >= 0; i--) {
				const prevPair = matchResult.find((p) => p.target === targetUnits[i] && p.source);
				if (prevPair?.source) {
					insertIndex = sourceUnits.indexOf(prevPair.source) + 1;
					break;
				}
				// 直前のターゲットがbackfill済みプレースホルダを持つ場合はその直後
				const prevHash = targetUnits[i].marker?.hash;
				const prevPlaceholderIdx = prevHash
					? sourceUnits.findIndex((u) => u.marker?.hash === prevHash)
					: -1;
				if (prevPlaceholderIdx >= 0) {
					insertIndex = prevPlaceholderIdx + 1;
					break;
				}
			}

			sourceUnits.splice(insertIndex, 0, placeholder);
			inserted++;
		}
		return inserted;
	}
}
