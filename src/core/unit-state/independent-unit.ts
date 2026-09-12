/**
 * @file independent-unit.ts
 * @description
 *   「原文と結びついていない訳文ユニット」（独立ユニット）の判定。
 *
 *   マーカーの語彙は3つあり、似ているが別物である。混ぜると画面の言葉が壊れる
 *   （ADR-260912-05）。
 *
 *   - **独立**（このファイル）: 訳文側で `from` が無い。対応する原文の章が無い。恒久。戻せない
 *   - **凍結**（`need:isolate`）: 更新を流さないという宣言。原文側にも宣言できるので `from` の
 *     有無は役割しだい（訳文側なら `from` を持ち、原文側はもともと持たない）。解除できる
 *   - **孤立**（`orphan-target.ts`）: 原文ファイルが消えた訳文。始末がまだ決まっていない
 *
 *   判定材料はマーカーと「訳文側のファイルか」だけで、ディスクもストアも見ない。
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
 * @param isTargetFile **訳文側のファイルだと分かっている**か。原文ユニットも `from` を持たず、
 *   さらに原文でも訳文でもない管理外の Markdown も在りうる（設定から外れた原稿・ワークスペース
 *   未設定）。「原文ではない」で代用すると、その両方まで独立ユニットになる。確かめられない
 *   ときは `false` を渡すこと — 出さなくても失うのは印だけだが、誤って出すと嘘になる
 */
export function isIndependentUnit(marker: IndependentUnitMarker | null | undefined, isTargetFile: boolean): boolean {
	if (!marker || !isTargetFile) {
		return false;
	}
	return Boolean(marker.hash) && !marker.from && !marker.need;
}
