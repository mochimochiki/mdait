/**
 * @file orphan-probe.ts
 * @description
 *   孤立訳文の判定（`core/unit-state/orphan-target.ts`）に、設定とファイルシステムを与える層。
 *
 *   判定そのものは core にある純粋関数で、ここは「訳文パス → 原文パス」の導出と実在確認を
 *   受け持つだけである。同じ導出は sync が訳文パスを作るときにも使われている
 *   （`FileExplorer.getTargetPath` の逆写像）ので、対応関係の定義は1つに保たれる。
 *
 * @module infra/workspace/orphan-probe
 */
import * as fs from "node:fs";
import { type OrphanTargetProbe, isOrphanTarget } from "../../core/unit-state/orphan-target";
import type { Configuration } from "../config/configuration";
import { FileExplorer } from "./file-explorer";
import { toAbsoluteWorkspacePath } from "./workspace-path";

/**
 * 絶対パスを受け取る孤立判定用の probe を作る。
 *
 * @param config 設定（pair の解決に使う）
 * @param explorer 使い回したい場合に渡す（省略時は都度生成）
 */
export function createOrphanTargetProbe(config: Configuration, explorer?: FileExplorer): OrphanTargetProbe {
	const fileExplorer = explorer ?? new FileExplorer();
	return {
		deriveSourcePath(targetPath: string): string | null {
			const pair = fileExplorer.getTransPairFromTarget(targetPath, config);
			if (!pair) {
				return null;
			}
			return fileExplorer.getSourcePath(targetPath, pair);
		},
		exists(filePath: string): boolean {
			return fs.existsSync(filePath);
		},
	};
}

/**
 * ワークスペース相対パス（`UnitStateEntry.path` と同じ基準）を受け取る probe を作る。
 *
 * `cleanupOrphansInScope` は行の `path` しか持たないため、絶対パスへ戻してから判定する。
 * ワークスペースが開かれていない等で変換に失敗したときは「判断できない」として
 * 孤立ではないと答える（＝掃除の判断を従来どおりに戻す。消す側へ倒さないための保険ではなく、
 * 変換できない時点で実在確認そのものができないため）。
 */
export function createRelativeOrphanTargetProbe(
	config: Configuration,
	explorer?: FileExplorer,
): (relativePath: string) => boolean {
	const probe = createOrphanTargetProbe(config, explorer);
	return (relativePath: string): boolean => {
		let absolutePath: string;
		try {
			absolutePath = toAbsoluteWorkspacePath(relativePath);
		} catch {
			return false;
		}
		return isOrphanTarget(absolutePath, probe);
	};
}
