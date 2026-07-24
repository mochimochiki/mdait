import * as path from "node:path";
import type { Configuration } from "../../infra/config/configuration";
import { SelectionState } from "./selection-state";

/**
 * 選択中の transPair に属するディレクトリ（source / target）の絶対パス集合を返す。
 *
 * ステータスツリー本体・要対応キュー・「次の要対応へ」が同じ範囲を見るための唯一の算出点。
 * 算出点が分かれていると、ツリーには出ていないファイルの項目が要対応にだけ並ぶ、といった
 * 不整合が生まれる（ADR-260724-01）。
 */
export function getSelectedScopeDirs(config: Configuration): string[] {
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
