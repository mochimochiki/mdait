import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describeIncompleteSweep } from "../../../../commands/sync/sync-command";
import { UnitStateStore } from "../../../../core/unit-state/unit-state-store";

declare let __vscodeMockWorkspaceRoot: string;

/**
 * 台帳の掃除を、この回の走査が届いた範囲に限る判定。
 *
 * 控えはどのファイルのものかを持っていないので、見に行かなかった場所から参照されている
 * 控えも「使われていない」と読まれて消える。届かなかった回は掃除そのものを見送る
 * （docs/design/merge-resilience.md）。
 */
suite("sync: 台帳の掃除を走らせてよい範囲か", () => {
	let tempDir: string;
	let mdaitDir: string;

	setup(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-sweep-scope-"));
		mdaitDir = path.join(tempDir, ".mdait");
		fs.mkdirSync(mdaitDir, { recursive: true });
		__vscodeMockWorkspaceRoot = tempDir;
		UnitStateStore.dispose();
	});

	teardown(() => {
		UnitStateStore.dispose();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	const loadState = (content: string): void => {
		fs.writeFileSync(path.join(mdaitDir, "unit-state"), content, "utf-8");
		UnitStateStore.getInstance().load(mdaitDir);
	};

	test("設定の全ディレクトリに手が届いていれば走らせる", () => {
		loadState("");
		const reason = describeIncompleteSweep({
			configuredDirs: ["docs/ja", "docs/en"],
			reachedDirs: ["docs/ja", "docs/en"],
			cancelled: false,
		});
		assert.equal(reason, null);
	});

	test("見に行けなかった設定ディレクトリがあれば走らせない", () => {
		loadState("");
		const reason = describeIncompleteSweep({
			configuredDirs: ["docs/ja", "docs/en", "docs/fr"],
			reachedDirs: ["docs/ja", "docs/en"],
			cancelled: false,
		});
		assert.ok(reason?.includes("docs/fr"), `走らせない理由に届かなかった場所が出ていない: ${reason}`);
	});

	test("原文が0件のペアでも、見に行けていれば走らせる", () => {
		// 「見に行って1件も無かった」は届いている。まだ訳文の無い言語を1つ足しただけで
		// 掃除が永久に走らなくなるのを防ぐ（守るべき控えは unit-state の行から拾える）
		loadState("");
		const reason = describeIncompleteSweep({
			configuredDirs: ["docs/ja", "docs/en", "docs/fr"],
			reachedDirs: ["docs/ja", "docs/en", "docs/fr"],
			cancelled: false,
		});
		assert.equal(reason, null);
	});

	test("途中で取り消された回は走らせない", () => {
		loadState("");
		const reason = describeIncompleteSweep({
			configuredDirs: ["docs/ja"],
			reachedDirs: ["docs/ja"],
			cancelled: true,
		});
		assert.ok(reason?.includes("cancelled"), `取り消しが理由に出ていない: ${reason}`);
	});

	test("unit-state を丸ごと読めなかった回は走らせない（合流の途中）", () => {
		loadState("<<<<<<< HEAD\n");
		const reason = describeIncompleteSweep({
			configuredDirs: ["docs/ja"],
			reachedDirs: ["docs/ja"],
			cancelled: false,
		});
		assert.ok(reason?.includes("unit-state"), `unit-state の傷が理由に出ていない: ${reason}`);
	});
});
