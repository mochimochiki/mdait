/**
 * 競合マーカーの2つの側のうち、どちらが自分の変更かを決めるテスト。
 *
 * rebase と stash pop では ours が他人の変更になる。取り違えると、自分の編集を残すつもりで
 * 他人の側を選ばせてしまう。
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isRebaseInProgress, mineSideFrom } from "../../../../core/conflict/conflict-orientation";

const mergeConflict = "<<<<<<< HEAD\nmine\n=======\nother\n>>>>>>> feature\n";
const stashConflict = "<<<<<<< Updated upstream\nother\n=======\nmine\n>>>>>>> Stashed changes\n";

suite("競合の自分の側", () => {
	test("ふつうのマージでは ours が自分の側", () => {
		assert.equal(mineSideFrom(mergeConflict, false), "ours");
	});

	test("rebase の途中では theirs が自分の側（ours は取り込み先）", () => {
		assert.equal(mineSideFrom(mergeConflict, true), "theirs");
	});

	test("stash pop の競合では theirs が自分の側（名札で見分ける）", () => {
		assert.equal(mineSideFrom(stashConflict, false), "theirs");
	});

	test("SVN の名札（.mine）では ours が自分の側", () => {
		assert.equal(mineSideFrom("<<<<<<< .mine\na\n=======\nb\n>>>>>>> .r42\n", false), "ours");
	});

	test("CRLF の stash の競合でも名札を読み取る", () => {
		assert.equal(mineSideFrom(stashConflict.replace(/\n/g, "\r\n"), false), "theirs");
	});
});

suite("rebase の途中かどうか", () => {
	let root: string;

	setup(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-orientation-"));
		fs.mkdirSync(path.join(root, ".mdait"), { recursive: true });
	});

	teardown(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	const file = () => path.join(root, ".mdait", "translations.tmx");

	test("git の管理下に無ければ rebase の途中ではない", () => {
		assert.equal(isRebaseInProgress(file()), false);
	});

	test("rebase-merge があれば rebase の途中", () => {
		fs.mkdirSync(path.join(root, ".git", "rebase-merge"), { recursive: true });

		assert.equal(isRebaseInProgress(file()), true);
	});

	test("rebase-apply でも rebasing の印があれば rebase の途中", () => {
		fs.mkdirSync(path.join(root, ".git", "rebase-apply"), { recursive: true });
		fs.writeFileSync(path.join(root, ".git", "rebase-apply", "rebasing"), "");

		assert.equal(isRebaseInProgress(file()), true);
	});

	test("git am の途中（rebase-apply に applying）は rebase ではない", () => {
		// am は HEAD（自分）の上に相手のパッチを当てるので、ours は自分のまま
		fs.mkdirSync(path.join(root, ".git", "rebase-apply"), { recursive: true });
		fs.writeFileSync(path.join(root, ".git", "rebase-apply", "applying"), "");

		assert.equal(isRebaseInProgress(file()), false);
	});

	test("linked worktree では .git ファイルの指す先を見る", () => {
		const worktreeGitDir = path.join(root, "main-repo", ".git", "worktrees", "wt");
		fs.mkdirSync(path.join(worktreeGitDir, "rebase-merge"), { recursive: true });
		const worktree = path.join(root, "wt");
		fs.mkdirSync(path.join(worktree, ".mdait"), { recursive: true });
		fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`);

		assert.equal(isRebaseInProgress(path.join(worktree, ".mdait", "translations.tmx")), true);
	});
});
