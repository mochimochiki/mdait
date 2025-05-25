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
