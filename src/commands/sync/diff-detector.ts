import type { MdaitSection } from "../../core/markdown/mdait-section";

/**
 * セクションの差分種別
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
 * セクション差分情報
 */
export interface SectionDiff {
	/** 差分種別 */
	type: DiffType;
	/** ソースセクション (削除の場合はnull) */
	source: MdaitSection | null;
	/** ターゲットセクション (新規の場合はnull) */
	target: MdaitSection | null;
}

/**
 * 差分検出結果
 */
export interface DiffResult {
	/** セクション毎の差分情報 */
	diffs: SectionDiff[];
	/** 追加されたセクション数 */
	added: number;
	/** 変更されたセクション数 */
	modified: number;
	/** 削除されたセクション数 */
	deleted: number;
	/** 変更なしのセクション数 */
	unchanged: number;
}

/**
 * 差分検出クラス
 */
export class DiffDetector {
	/**
	 * 同期前後のセクション配列から差分を検出
	 * @param originalSections 元のセクション配列
	 * @param syncedSections 同期後のセクション配列
	 */
	detect(
		originalSections: MdaitSection[],
		syncedSections: MdaitSection[],
	): DiffResult {
		const diffs: SectionDiff[] = [];
		let added = 0;
		let modified = 0;
		let deleted = 0;
		let unchanged = 0;

		// 削除セクションの特定
		// (syncedに無いoriginalのセクション)
		const originalMap = new Map<string, MdaitSection>();
		for (const section of originalSections) {
			if (section.mdaitHeader?.hash) {
				originalMap.set(section.mdaitHeader.hash, section);
			}
		}

		// 追加・変更セクションの特定
		const syncedMap = new Map<string, MdaitSection>();
		for (const section of syncedSections) {
			if (section.mdaitHeader?.hash) {
				syncedMap.set(section.mdaitHeader.hash, section);
			}
		}

		// 削除されたセクションを特定
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

		// 追加・変更・変更なしのセクションを特定
		syncedMap.forEach((section, hash) => {
			const original = originalMap.get(hash);

			if (!original) {
				// 新規セクション
				diffs.push({
					type: DiffType.ADDED,
					source: section,
					target: null,
				});
				added++;
			} else if (section.content !== original.content) {
				// 変更セクション
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
