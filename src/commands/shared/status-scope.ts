import * as path from "node:path";
import { SelectionState } from "../../core/status/selection-state";
import type { TransPair } from "../../infra/config/configuration";

/** getSelectedScopeDirs が必要とする設定の最小形（テスト容易性のため構造で受ける） */
export interface ScopeConfig {
	getConfigBaseDir(): string;
	transPairs: TransPair[];
}

/**
 * 選択中の transPair に属するディレクトリ（source / target）の絶対パス集合を返す。
 *
 * ステータスツリー本体・要対応キュー・「次の要対応へ」が同じ範囲を見るための唯一の算出点。
 * 算出点が分かれていると、ツリーには出ていないファイルの項目が要対応にだけ並ぶ、といった
 * 不整合が生まれる（ADR-260724-01）。
 *
 * core ではなく commands 層に置く。SelectionState は UI セッションの選択状態であり、
 * core（純粋な翻訳ロジック）が知るべきものではないため（ADR-260724-01 の決定4）。
 */
export function getSelectedScopeDirs(config: ScopeConfig): string[] {
	const configBaseDir = config.getConfigBaseDir();
	const pairs = SelectionState.getInstance().filterTransPairs(
		config.transPairs,
	);
	return Array.from(
		new Set(
			pairs.flatMap((pair) => [
				path.resolve(configBaseDir, pair.sourceDir),
				path.resolve(configBaseDir, pair.targetDir),
			]),
		),
	);
}
