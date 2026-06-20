import type { MdaitUnit } from "./mdait-unit";

/**
 * 指定行（0ベース）を含むユニットを返す。見つからなければ null。
 *
 * external マーカーモードでは本文にマーカーが無いため、CodeLens / Hover の位置判定を
 * 行マーカー走査ではなくユニットの行範囲（startLine〜endLine）で行う必要がある。
 * その判定をこの純関数に切り出して単体テスト可能にする。
 *
 * @param units 探索対象のユニット配列
 * @param line 0ベースの行番号
 */
export function findUnitAtLine(units: readonly MdaitUnit[], line: number): MdaitUnit | null {
	for (const unit of units) {
		if (line >= unit.startLine && line <= unit.endLine) {
			return unit;
		}
	}
	return null;
}
