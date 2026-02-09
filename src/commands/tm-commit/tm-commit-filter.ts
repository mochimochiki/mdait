/**
 * @file tm-commit-filter.ts
 * @description
 *   TM登録対象のフィルタリングロジック。
 *   ユニットがTM処理対象かどうかを判定する純粋関数。
 * @module commands/tm-commit/tm-commit-filter
 */
import type { MdaitUnit } from "../../core/markdown/mdait-unit";

/**
 * ユニットがTM処理対象かどうか判定する。
 *
 * 対象条件:
 * - from属性あり（ターゲットファイルのユニット）
 * - need:translate でない（翻訳済み）
 * - need:revise@ でない（旧版訳文）
 * - need:review でない（レビュー待ち）
 */
export function isTmCommitTarget(unit: MdaitUnit): boolean {
	if (!unit.marker?.from) {
		return false;
	}
	if (unit.marker.need === "translate") {
		return false;
	}
	if (unit.marker.need?.startsWith("revise@")) {
		return false;
	}
	if (unit.marker.need === "review") {
		return false;
	}
	return true;
}
