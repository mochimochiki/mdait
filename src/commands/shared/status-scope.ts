import * as path from "node:path";
import { SelectionState } from "../../core/status/selection-state";
import type { FileStatusItem } from "../../core/status/status-item";
import type { StatusItemTree } from "../../core/status/status-item-tree";
import { Configuration, type TransPair } from "../../infra/config/configuration";

/** getSelectedScopeDirs が必要とする設定の最小形（テスト容易性のため構造で受ける） */
export interface ScopeConfig {
	getConfigBaseDir(): string;
	transPairs: TransPair[];
}

/**
 * 選択中の transPair に属するディレクトリ（source / target）の絶対パス集合を返す。
 *
 * ステータスツリー本体・要対応キュー・「次の要対応へ」・LM Tools の集計が
 * 同じ範囲を見るための唯一の算出点。算出点が分かれていると、ツリーには出ていない
 * ファイルの項目が要対応にだけ並ぶ、人間とエージェントで件数が食い違う、といった
 * 不整合が生まれる（ADR-260724-01）。
 *
 * core ではなく commands 層に置く。SelectionState は UI セッションの選択状態であり、
 * core（純粋な翻訳ロジック）が知るべきものではないため（ADR-260724-01 の決定4）。
 */
export function getSelectedScopeDirs(config: ScopeConfig): string[] {
	const configBaseDir = config.getConfigBaseDir();
	const pairs = SelectionState.getInstance().filterTransPairs(config.transPairs);
	return Array.from(
		new Set(
			pairs.flatMap((pair) => [
				path.resolve(configBaseDir, pair.sourceDir),
				path.resolve(configBaseDir, pair.targetDir),
			]),
		),
	);
}

/**
 * 選択中の transPair ごとの source / target ディレクトリ絶対パスの組を返す。
 * ペア単位の集計（未同期ファイル数の表示など）が getSelectedScopeDirs と
 * 同じ選択状態・同じパス解決を共有するための算出点。
 */
export function getSelectedPairAbsDirs(config: ScopeConfig): { sourceDirAbs: string; targetDirAbs: string }[] {
	const configBaseDir = config.getConfigBaseDir();
	return SelectionState.getInstance()
		.filterTransPairs(config.transPairs)
		.map((pair) => ({
			sourceDirAbs: path.resolve(configBaseDir, pair.sourceDir),
			targetDirAbs: path.resolve(configBaseDir, pair.targetDir),
		}));
}

/**
 * 選択中の transPair に属するファイルのみをステータスツリーから取得する。
 *
 * ワークスペース全体を対象にする集計（LM Tools のステータス要約など）は必ずこれを通す。
 * sync / trans は元から選択中のペアだけを処理するため、集計だけが全ペアを数えると
 * 「エージェントには見えるが誰も処理しない件数」が報告されることになる。
 */
export function getSelectedScopeFiles(tree: StatusItemTree): FileStatusItem[] {
	return tree.getFilesInScope(getSelectedScopeDirs(Configuration.getInstance()));
}

/**
 * 選択中の対象言語（targetLang、無ければ targetDir）の一覧を返す。
 * 集計結果がどの範囲のものかをエージェントに伝えるために使う。
 */
export function getSelectedTargetLabels(): string[] {
	const config = Configuration.getInstance();
	return SelectionState.getInstance()
		.filterTransPairs(config.transPairs)
		.map((pair) => pair.targetLang ?? pair.targetDir);
}
