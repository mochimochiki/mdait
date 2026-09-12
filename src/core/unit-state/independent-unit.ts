/**
 * @file independent-unit.ts
 * @description
 *   「原文と結びついていない訳文ユニット」（独立ユニット）の判定。
 *
 *   マーカーの語彙は3つあり、似ているが別物である。混ぜると画面の言葉が壊れる
 *   （ADR-260912-05）。
 *
 *   - **独立**（このファイル）: `from` が無い。対応する原文の章が無い。恒久。戻せない
 *   - **凍結**（`need:isolate`）: `from` はある。原文の章は在るが、更新を流さない。解除できる
 *   - **孤立**（`orphan-target.ts`）: 原文ファイルが消えた訳文。始末がまだ決まっていない
 *
 *   判定材料はマーカーと「原文側のファイルか」だけで、ディスクもストアも見ない。
 *
 * @module core/unit-state/independent-unit
 */

/** 判定に使うマーカーの部分（`MdaitMarker` をそのまま渡せる） */
export interface IndependentUnitMarker {
	hash: string;
	from: string | null;
	need: string | null;
}

/**
 * そのユニットは独立ユニットか。
 *
 * `need` が付いているユニットは独立ユニットとして扱わない。`from` を持たない `need:review`
 * （adopt の穴あき一次受け）や、レガシーの `from` なし `need:verify-deletion` が該当する。
 * どちらも人の裁定を待っている最中であり、その裁定こそが先に伝わらなければならないためである
 * （sync が削除から守る範囲はこれより広い。あちらは「消さない対象」を決める別の問い）。
 *
 * @param marker 対象ユニットのマーカー
 * @param isSourceFile 原文側のファイルか（原文ユニットも `from` を持たないが、あれは原文であって
 *   独立ユニットではない）
 */
export function isIndependentUnit(marker: IndependentUnitMarker | null | undefined, isSourceFile: boolean): boolean {
	if (!marker || isSourceFile) {
		return false;
	}
	return Boolean(marker.hash) && !marker.from && !marker.need;
}
