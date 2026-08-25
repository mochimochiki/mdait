import type { MdaitUnit } from "../../core/markdown/mdait-unit";

/**
 * 差分種別
 */
export enum DiffType {
	/** 変更なし */
	UNCHANGED = 0,
	/** 新規追加 */
	ADDED = 1,
	/** 内容変更 */
	MODIFIED = 2,
	/** 削除 */
	DELETED = 3,
}

/**
 * ユニット差分情報
 */
export interface UnitDiff {
	/** 差分種別 */
	type: DiffType;
	/** ソースユニット (削除の場合はnull) */
	source: MdaitUnit | null;
	/** ターゲットユニット (新規の場合はnull) */
	target: MdaitUnit | null;
}

/**
 * 差分検出結果
 */
export interface DiffResult {
	/** ユニット毎の差分情報 */
	diffs: UnitDiff[];
	/** 追加されたユニット数 */
	added: number;
	/** 変更されたユニット数 */
	modified: number;
	/** 削除されたユニット数 */
	deleted: number;
	/** 変更なしのユニット数 */
	unchanged: number;
	/** need:revise付与件数 */
	revisionsNeeded?: number;
	/** adoptで採用（need:review付与）したユニット数 */
	adopted?: number;
	/** 独立ユニットとして保持している孤立ターゲット数 */
	kept?: number;
	/** need:verify-deletion を付与した孤立ターゲット数 */
	orphanVerified?: number;
	/** need:review を一次受け付与したマーカーなし孤立ターゲット数 */
	orphanReviewed?: number;
	/** 崩れを疑って自動削除を見送り、確認待ちにした孤立ターゲット数 */
	orphanDeletionWithheld?: number;
	/** 削除した孤立ターゲットの見出し（通知で「何が消えたか」を言うため） */
	orphanDeletedTitles?: string[];
	/** AIアラインが適用した修正提案数 */
	alignCorrections?: number;
	/** 原文が空になったため訳文に触れずに中止したファイル数（0 or 1） */
	sourceEmptied?: number;
	/** 訳文が空になったため状態を守って中止したファイル数（0 or 1） */
	targetEmptied?: number;
}

/**
 * 差分検出クラス
 */
export class DiffDetector {
	/**
	 * 同期前後のユニット配列から差分を検出
	 * @param originalUnits 元のユニット配列
	 * @param syncedUnits 同期後のユニット配列
	 */
	detect(originalUnits: MdaitUnit[], syncedUnits: MdaitUnit[]): DiffResult {
		const diffs: UnitDiff[] = [];
		let added = 0;
		let modified = 0;
		let deleted = 0;
		let unchanged = 0;

		// 削除ユニットの特定
		// (syncedに無いoriginalのユニット)
		const originalMap = new Map<string, MdaitUnit>();
		for (const section of originalUnits) {
			if (section.marker?.hash) {
				originalMap.set(section.marker.hash, section);
			}
		}

		// 追加・変更ユニットの特定
		const syncedMap = new Map<string, MdaitUnit>();
		for (const section of syncedUnits) {
			if (section.marker?.hash) {
				syncedMap.set(section.marker.hash, section);
			}
		}

		// 削除されたユニットを特定
		originalMap.forEach((section, hash) => {
			if (!syncedMap.has(hash)) {
				diffs.push({
					type: DiffType.DELETED,
					source: null,
					target: section,
				});
				deleted++;
			}
		});

		// 追加・変更・変更なしのユニットを特定
		syncedMap.forEach((section, hash) => {
			const original = originalMap.get(hash);

			if (!original) {
				// 新規ユニット
				diffs.push({
					type: DiffType.ADDED,
					source: section,
					target: null,
				});
				added++;
			} else if (section.content !== original.content) {
				// 変更ユニット
				diffs.push({
					type: DiffType.MODIFIED,
					source: section,
					target: original,
				});
				modified++;
			} else {
				// 変更なし
				diffs.push({
					type: DiffType.UNCHANGED,
					source: section,
					target: original,
				});
				unchanged++;
			}
		});

		return {
			diffs,
			added,
			modified,
			deleted,
			unchanged,
		};
	}
}
