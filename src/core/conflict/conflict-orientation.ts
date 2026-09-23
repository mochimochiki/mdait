/**
 * @file conflict-orientation.ts
 * @description
 *   競合マーカーの2つの側のうち、**どちらが自分の変更か**を決める。
 *
 *   git は `<<<<<<<` 側を ours、`>>>>>>>` 側を theirs と書く。ふつうのマージでは ours が
 *   自分のブランチだが、**次の2つでは逆になる**。
 *
 *   - **rebase の途中**（`git pull --rebase` を含む）。rebase は取り込み先の上に自分の
 *     コミットを1つずつ積み直すので、ours は取り込み先（他人の変更）、theirs が自分のコミットになる
 *   - **`git stash pop` / `apply`**。ours は取り込んだあとの作業ツリー（他人の変更を含む）、
 *     theirs が退避していた自分の変更になる。マーカーの名札が `Updated upstream` /
 *     `Stashed changes` になる
 *
 *   ここを見ずに ours を「あなた」と表示すると、自分の編集を残すつもりで他人の側を選ぶことになる。
 *
 *   `git am` の途中も `rebase-apply` を使うが、am は HEAD（自分）の上にパッチ（相手）を
 *   当てるので逆にならない。rebase と am は `rebase-apply` の中の印（`rebasing` / `applying`）で
 *   見分ける。SVN の名札（`.mine` / `.r42`）は ours が自分なので逆にならない。
 *
 * @module core/conflict/conflict-orientation
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { isConflictMarkerLine } from "../markdown/conflict-markers";
import type { ConflictSide } from "./key-merge";

/**
 * 競合マーカーの入った中身と、git が rebase の途中かどうかから、自分の側を決める（純関数）。
 *
 * @param content 競合マーカーの入ったファイルの中身
 * @param rebasing git が rebase の途中か
 */
export function mineSideFrom(content: string, rebasing: boolean): ConflictSide {
	if (rebasing || isStashConflict(content)) {
		return "theirs";
	}
	return "ours";
}

/** `git stash pop` / `apply` が残した競合か（マーカーの名札で見分ける） */
function isStashConflict(content: string): boolean {
	for (const line of content.split(/\r?\n/)) {
		if (!isConflictMarkerLine(line)) {
			continue;
		}
		const label = line.slice(7).trim();
		if (
			(line.startsWith("<<<<<<<") && label === "Updated upstream") ||
			(line.startsWith(">>>>>>>") && label === "Stashed changes")
		) {
			return true;
		}
	}
	return false;
}

/**
 * そのファイルの置かれた git の作業場が rebase の途中か。
 *
 * git の管理下に無い・読めないときは false（ふつうのマージとして扱う）。
 */
export function isRebaseInProgress(filePath: string): boolean {
	const gitDir = findGitDir(path.dirname(filePath));
	if (!gitDir) {
		return false;
	}
	return (
		fs.existsSync(path.join(gitDir, "rebase-merge")) ||
		fs.existsSync(path.join(gitDir, "rebase-apply", "rebasing"))
	);
}

/**
 * 親をたどって git の管理ディレクトリを探す。
 *
 * linked worktree とサブモジュールでは `.git` がファイルで、`gitdir: <パス>` と書いてある。
 * rebase の印はその先（worktree ごとの管理ディレクトリ）に置かれるので、そこまで引く。
 */
function findGitDir(startDir: string): string | undefined {
	let dir = startDir;
	for (;;) {
		const candidate = path.join(dir, ".git");
		try {
			const stat = fs.statSync(candidate);
			if (stat.isDirectory()) {
				return candidate;
			}
			const match = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(candidate, "utf-8"));
			return match ? path.resolve(dir, match[1]) : undefined;
		} catch {
			// この階層には無い。親へ
		}
		const parent = path.dirname(dir);
		if (parent === dir) {
			return undefined;
		}
		dir = parent;
	}
}

/**
 * 競合したファイルの、自分の側（rebase の途中か・stash の名札かを見て決める）。
 *
 * @param filePath 競合したファイル（絶対パス）
 * @param content そのファイルの中身
 */
export function mineSideOf(filePath: string, content: string): ConflictSide {
	return mineSideFrom(content, isRebaseInProgress(filePath));
}
