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
import type { OrphanTargetProbe } from "../../core/unit-state/orphan-target";
import type { Configuration } from "../config/configuration";
import { FileExplorer } from "./file-explorer";
import { toAbsoluteWorkspacePath } from "./workspace-path";

/**
 * 絶対パスを受け取る孤立判定用の probe を作る。
 *
 * 実在確認の結果は probe の生存期間だけ覚える。掃除はストアの行ごとに判定を呼ぶので、
 * 1ファイル100ユニットなら同じパスへ200回 `existsSync` が飛ぶ。
 * probe は1回の走査ごとに作り直す前提なので、その間にファイルが増減しても取りこぼさない。
 *
 * @param config 設定（pair の解決に使う）
 * @param explorer 使い回したい場合に渡す（省略時は都度生成）
 */
export function createOrphanTargetProbe(config: Configuration, explorer?: FileExplorer): OrphanTargetProbe {
	const fileExplorer = explorer ?? new FileExplorer();
	const existsCache = new Map<string, boolean>();
	return {
		deriveSourcePath(targetPath: string): string | null {
			// そのファイル自身がどれかのペアの原文なら、訳文として孤立していても手放せない。
			// `ja→en, en→fr` のようにディレクトリが原文と訳文を兼ねる構成では、`ja` を消すと
			// `en/x.md` が「原文の無い訳文」に見えるが、それは `fr` の現役の原文である。
			// 破棄を勧めれば `fr/x.md` を新たに孤立させることになる（パス計算だけで済むので
			// 実在確認より先に置く）。
			if (fileExplorer.isSourceFile(targetPath, config)) {
				return null;
			}
			const pair = fileExplorer.getTransPairFromTarget(targetPath, config);
			if (!pair) {
				return null;
			}
			return fileExplorer.getSourcePath(targetPath, pair);
		},
		exists(filePath: string): boolean {
			const cached = existsCache.get(filePath);
			if (cached !== undefined) {
				return cached;
			}
			const found = fs.existsSync(filePath);
			existsCache.set(filePath, found);
			return found;
		},
	};
}

/**
 * ワークスペース相対パス（`UnitStateEntry.path` と同じ基準）で実在を答える probe を作る。
 *
 * `cleanupOrphansInScope` は行の `path` しか持たないため、絶対パスへ戻してから確かめる。
 * 掃除はストアの行ごとに呼ぶので（1ファイル100ユニットなら同じパスへ100回）結果を覚える。
 * probe は1回の走査ごとに作り直す前提なので、その間にファイルが増減しても取りこぼさない。
 *
 * ワークスペースが開かれていない等で変換に失敗したときは「無い」と答える — 変換できない
 * 時点で実在確認そのものができないため、この規則が無かった頃と同じ扱いに落とす。
 */
export function createRelativeExistsProbe(): (relativePath: string) => boolean {
	const verdicts = new Map<string, boolean>();
	return (relativePath: string): boolean => {
		const cached = verdicts.get(relativePath);
		if (cached !== undefined) {
			return cached;
		}
		let verdict = false;
		try {
			verdict = fs.existsSync(toAbsoluteWorkspacePath(relativePath));
		} catch {
			verdict = false;
		}
		verdicts.set(relativePath, verdict);
		return verdict;
	};
}
