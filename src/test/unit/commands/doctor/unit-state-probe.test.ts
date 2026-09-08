// 診断（doctor）が `.mdait/unit-state` から「行を持つファイル」を数えるところの単体テスト。
//
// 行はファイルIDで自分を名乗り、パスを持つのは見出し `# <id> <path>` だけである
// （ADR-260908-04）。先頭列をパスとして数えると、external の作業場で常に0件になり、
// 「まず Sync してください」を誤って出す。

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createFsProbe } from "../../../../commands/doctor/doctor-command";

function withWorkspace(unitState: string, run: (dir: string) => void): void {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-doctor-"));
	try {
		fs.mkdirSync(path.join(dir, ".mdait"), { recursive: true });
		fs.writeFileSync(path.join(dir, ".mdait", "unit-state"), unitState, "utf-8");
		run(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

suite("診断が unit-state の行を持つファイルを数える", () => {
	test("いまの形（見出しが ID とパスの対応を持つ）を数えられること", () => {
		const content = [
			"# mdait unit-state — 翻訳ユニットの状態管理",
			"# id\tkind\tseat\tlevel\ttitleHash\thash\tfrom\tneed",
			"",
			"# 0123456789ab content/en/a.md",
			"",
			"# u50000000",
			"0123456789ab\tunit\t50000000\t1\tth\thash0\tfrom0\t",
			"",
			"# 0123456789ab [unseated]",
			"",
			"# cafebabe0001 content/en/b.txt",
			"",
			"# u50000000",
			"cafebabe0001\tunit\t50000000\t0\t\thash1\tfrom1\t",
			"",
			"# cafebabe0001 [unseated]",
			"",
		].join("\n");
		withWorkspace(content, (dir) => {
			assert.equal(createFsProbe(dir).countFilesWithUnitState("content/en"), 2);
		});
	});

	test("旧い形（先頭列がパス）の作業場も数えられること", () => {
		const content = [
			"# mdait unit-state — 翻訳ユニットの状態管理",
			"",
			"# content/en/a.md",
			"",
			"content/en/a.md\tunit\t50000000\t1\tth\thash0\tfrom0\t",
			"",
		].join("\n");
		withWorkspace(content, (dir) => {
			assert.equal(createFsProbe(dir).countFilesWithUnitState("content/en"), 1);
		});
	});

	test("別のディレクトリの行は数に入らないこと", () => {
		const content = [
			"# mdait unit-state — 翻訳ユニットの状態管理",
			"",
			"# 0123456789ab content/fr/a.md",
			"",
			"0123456789ab\tunit\t50000000\t1\tth\thash0\tfrom0\t",
			"",
		].join("\n");
		withWorkspace(content, (dir) => {
			assert.equal(createFsProbe(dir).countFilesWithUnitState("content/en"), 0);
		});
	});
});
