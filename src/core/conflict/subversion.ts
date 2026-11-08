/**
 * @file subversion.ts
 * @description
 *   作業場が Subversion の作業コピーかどうかを答える。
 *
 *   mdait は `.mdait` の中の競合をファイルの中身だけで解く。Subversion は競合したファイルを
 *   `svn resolve` されるまで「競合中」として持ち続け、そのあいだはコミットを拒む（実測:
 *   `E155015 remains in conflict`）。mdait が解き終えても、利用者にはそれが分からない。
 *   その一言を添えるかどうかを、ここで決める。
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * `startDir` から親をたどり、`.svn` ディレクトリが見つかれば Subversion の作業コピーとみなす。
 *
 * Subversion 1.7 以降は作業コピーの根にだけ `.svn` を置くので、親までたどる必要がある。
 *
 * @param startDir たどり始めるディレクトリ（`.mdait` など）
 */
export function isSubversionWorkingCopy(startDir: string): boolean {
	let dir = path.resolve(startDir);
	for (;;) {
		try {
			if (fs.statSync(path.join(dir, ".svn")).isDirectory()) {
				return true;
			}
		} catch {
			// この階層には無い。親へ
		}
		const parent = path.dirname(dir);
		if (parent === dir) {
			return false;
		}
		dir = parent;
	}
}
