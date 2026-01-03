/**
 * @file unit-pair.ts
 * @description ソース・ターゲットのユニットペア型定義
 */

import type { MdaitUnit } from "../../core/markdown/mdait-unit";

/**
 * ソース・ターゲットのユニットペア
 * targetがundefinedの場合は対訳なし（特殊ケース）
 */
export interface UnitPair {
	/** ソースユニット（必須） */
	readonly source: MdaitUnit;
	/** ターゲットユニット（対訳なしの場合はundefined） */
	readonly target?: MdaitUnit;
}

/**
 * UnitPairのユーティリティ関数群
 */
export namespace UnitPair {
	/**
	 * 新しいUnitPairを作成
	 */
	export function create(source: MdaitUnit, target?: MdaitUnit): UnitPair {
		return { source, target };
	}

	/**
	 * ペアが翻訳済みの対訳を持つかどうか
	 * targetが存在し、かつneed:translateでない場合のtrue
	 */
	export function hasTarget(pair: UnitPair): boolean {
		if (!pair.target) {
			return false;
		}
		// need:translateなど翻訳が必要な場合は対訳として扱わない
		return !pair.target.marker?.needsTranslation();
	}

	/**
	 * ペアの合計文字数を取得（バッチ分割用）
	 */
	export function getCharCount(pair: UnitPair): number {
		const sourceChars = pair.source.content.length;
		const targetChars = pair.target?.content.length ?? 0;
		return sourceChars + targetChars;
	}
}
