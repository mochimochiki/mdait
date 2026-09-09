import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describeIncompleteSweep } from "../../../../commands/sync/sync-command";
import { collectMarkerHashesFromText, sweepMarkerHashes } from "../../../../commands/sync/registry-sweep";
import { UnitStateStore } from "../../../../core/unit-state/unit-state-store";

declare let __vscodeMockWorkspaceRoot: string;

/**
 * 台帳の掃除が守るべき印を、選択で絞らずに集めること。
 *
 * 控えはどのファイルのものかを持っていないので、消してよいと言えるのはワークスペース
 * 全体を見たときだけである。翻訳者はふだん対象言語を絞って作業するため、掃除の走査は
 * sync の作業範囲から切り離す（docs/design/merge-resilience.md）。
 */
suite("sync: 掃除の走査は選択で絞らない", () => {
	let tempDir: string;

	setup(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-sweep-"));
		__vscodeMockWorkspaceRoot = tempDir;
	});

	teardown(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	const write = (relativePath: string, content: string): void => {
		const full = path.join(tempDir, relativePath);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, content, "utf-8");
	};

	suite("1ファイルからの拾い上げ", () => {
		test("埋め込みマーカーの hash・from・revise@X をすべて拾う", () => {
			const hashes = collectMarkerHashesFromText(
				"<!-- mdait aaaa1111 from:bbbb2222 need:revise@cccc3333 -->\n# 見出し\n",
			);
			assert.deepEqual([...new Set(hashes)].sort(), ["aaaa1111", "bbbb2222", "cccc3333"]);
		});

		test("frontmatter の mdait.front の行も拾う", () => {
			const hashes = collectMarkerHashesFromText("---\ntitle: t\nmdait.front: dddd4444 from:eeee5555\n---\n");
			assert.deepEqual([...new Set(hashes)].sort(), ["dddd4444", "eeee5555"]);
		});

		test("マーカーと関係のない行の16進は拾わない", () => {
			assert.deepEqual(collectMarkerHashesFromText("コミット deadbeef を参照。\n"), []);
		});
	});

	suite("フォルダの走査", () => {
		test("選択で絞っていない全言語の原稿から印を集める", () => {
			write("docs/ja/a.md", "<!-- mdait aaaa1111 -->\n# 原文\n");
			write("docs/en/a.md", "<!-- mdait bbbb2222 from:aaaa1111 -->\n# English\n");
			write("docs/fr/a.md", "<!-- mdait cccc3333 from:aaaa1111 need:revise@9999ffff -->\n# Français\n");

			// en だけを選んでいても、走査には fr も渡る（呼び出し側が config の全 pair を渡す）
			const swept = sweepMarkerHashes(
				[path.join(tempDir, "docs/ja"), path.join(tempDir, "docs/en"), path.join(tempDir, "docs/fr")],
				[".md"],
			);

			assert.ok(swept.hashes.has("cccc3333"), "選んでいない言語の印が拾えていない");
			assert.ok(swept.hashes.has("9999ffff"), "選んでいない言語の revise@X の戻り先が拾えていない");
			assert.equal(swept.filesRead, 3);
			assert.deepEqual(swept.unreadableDirs, []);
		});

		test("設定した拡張子のファイルも読む", () => {
			write("docs/ja/a.txt", "<!-- mdait aaaa1111 -->\n本文\n");
			write("docs/ja/a.json", "<!-- mdait bbbb2222 -->\n");
			const swept = sweepMarkerHashes([path.join(tempDir, "docs/ja")], [".md", ".txt"]);
			assert.ok(swept.hashes.has("aaaa1111"));
			assert.ok(!swept.hashes.has("bbbb2222"), "対象外の拡張子まで読んでいる");
		});

		test("まだ無いフォルダは失敗にしない（訳文を1つも作っていない言語）", () => {
			write("docs/ja/a.md", "<!-- mdait aaaa1111 -->\n# 原文\n");
			const swept = sweepMarkerHashes(
				[path.join(tempDir, "docs/ja"), path.join(tempDir, "docs/de")],
				[".md"],
			);
			assert.deepEqual(swept.unreadableDirs, []);
			assert.ok(swept.hashes.has("aaaa1111"));
		});

		test(".mdait や .git の中は読まない", () => {
			write(".mdait/reports/sync.md", "<!-- mdait aaaa1111 -->\n");
			write("docs/ja/.git/x.md", "<!-- mdait bbbb2222 -->\n");
			write("docs/ja/a.md", "<!-- mdait cccc3333 -->\n");
			const swept = sweepMarkerHashes([tempDir], [".md"]);
			assert.ok(swept.hashes.has("cccc3333"));
			assert.ok(!swept.hashes.has("aaaa1111"), ".mdait の中まで読んでいる");
			assert.ok(!swept.hashes.has("bbbb2222"), ".git の中まで読んでいる");
		});
	});

	suite("掃除を見送る条件", () => {
		const loadState = (content: string): void => {
			const mdaitDir = path.join(tempDir, ".mdait");
			fs.mkdirSync(mdaitDir, { recursive: true });
			fs.writeFileSync(path.join(mdaitDir, "unit-state"), content, "utf-8");
			UnitStateStore.dispose();
			UnitStateStore.getInstance().load(mdaitDir);
		};

		teardown(() => {
			UnitStateStore.dispose();
		});

		test("走査が通れば走らせる", () => {
			loadState("");
			assert.equal(describeIncompleteSweep({ cancelled: false, unreadableDirs: [] }), null);
		});

		test("在るのに読めなかったフォルダがあれば走らせない", () => {
			loadState("");
			const reason = describeIncompleteSweep({ cancelled: false, unreadableDirs: ["docs/fr"] });
			assert.ok(reason?.includes("docs/fr"), `読めなかった場所が理由に出ていない: ${reason}`);
		});

		test("途中で取り消された回は走らせない", () => {
			loadState("");
			const reason = describeIncompleteSweep({ cancelled: true, unreadableDirs: [] });
			assert.ok(reason?.includes("cancelled"), `取り消しが理由に出ていない: ${reason}`);
		});

		test("unit-state を丸ごと読めなかった回は走らせない（合流の途中）", () => {
			loadState("<<<<<<< HEAD\n");
			const reason = describeIncompleteSweep({ cancelled: false, unreadableDirs: [] });
			assert.ok(reason?.includes("unit-state"), `unit-state の傷が理由に出ていない: ${reason}`);
		});
	});
});
