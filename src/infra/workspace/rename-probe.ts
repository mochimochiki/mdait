/**
 * @file rename-probe.ts
 * @description
 *   移動への追随の計画（`core/unit-state/rename-plan.ts`）に、設定とファイルシステムを与える層。
 *
 *   ペアの対応関係（どの原文がどの訳文になるか）は `FileExplorer.getTargetPath` にしか
 *   置かない。sync が訳文を作るときに使うのと同じ写像をここでも使うことで、
 *   「sync が作る場所」と「移動で連れて行く場所」が食い違わないようにしている。
 *
 *   選択（`SelectionState`）で絞らないのは、選ばれていない言語の訳文もディスク上には
 *   実在するためである。絞ると、選択から外れている訳文だけが取り残されて孤立になる。
 *
 * @module infra/workspace/rename-probe
 */
import * as fs from "node:fs";
import type { PathRename, RenameFollowProbe } from "../../core/unit-state/rename-plan";
import { UnitStateStore } from "../../core/unit-state/unit-state-store";
import type { Configuration } from "../config/configuration";
import { FileExplorer } from "./file-explorer";
import { normalizeFileKey } from "./file-key";
import { toWorkspaceRelativePath } from "./workspace-path";

/**
 * 移動への追随を計画するための probe を作る。
 *
 * パスの計算は文字列だけで行われるため、ファイルにもディレクトリにも同じように効く
 * （フォルダの移動はイベント1件でファイルが何十件も動くので、ディレクトリを
 * ディレクトリのまま扱えることが要る）。
 *
 * @param config 設定（pair の解決に使う）
 * @param explorer 使い回したい場合に渡す（省略時は都度生成）
 */
export function createRenameFollowProbe(config: Configuration, explorer?: FileExplorer): RenameFollowProbe {
	const fileExplorer = explorer ?? new FileExplorer();
	return {
		deriveTargetRenames(rename: PathRename): PathRename[] {
			const pairs = fileExplorer.getTransPairsFromSource(rename.oldPath, config);
			const derived: PathRename[] = [];
			for (const pair of pairs) {
				const oldTarget = fileExplorer.getTargetPath(rename.oldPath, pair);
				const newTarget = fileExplorer.getTargetPath(rename.newPath, pair);
				// 移動先が原文ディレクトリの外なら newTarget は null になる。
				// そのときは連れて行かない — 原文が管理から外れた以上、行き先が無い
				if (oldTarget && newTarget) {
					derived.push({ oldPath: oldTarget, newPath: newTarget });
				}
			}
			return derived;
		},
		exists(filePath: string): boolean {
			return fs.existsSync(filePath);
		},
		hasEntriesAt(filePath: string): boolean {
			// ワークスペース外・未設定なら「知らない」と答える。ここで例外を投げると
			// ユーザーのリネームごと巻き添えにする（追随は付随的な仕事である）
			let rel: string;
			try {
				rel = toWorkspaceRelativePath(filePath);
			} catch {
				return false;
			}
			return UnitStateStore.getInstance().hasEntriesAtOrUnder(rel);
		},
		sameKey(filePath: string): string {
			return normalizeFileKey(filePath);
		},
	};
}
