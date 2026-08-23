/**
 * @file executed-command-ids.test.ts
 * @description 製品コードが executeCommand で呼ぶ mdait.* のコマンド ID が、
 * すべて実際に存在することを固定する。
 *
 * 実測で見つかった欠陥の回帰固定: 用語集の案内が、どこにも登録されていない
 * mdait.term.detect.file を呼んでいた。実 Extension Host では
 * "command 'mdait.term.detect.file' not found" になり、ボタンが必ず失敗していた。
 * 呼び出し側の単体テストだけでは「宛先が実在するか」を見張れないため、
 * ソースを走査して突き合わせる。
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

/** リポジトリのルート（out/test/unit/commands から4つ上） */
const repoRoot = path.resolve(__dirname, "..", "..", "..", "..");
const srcRoot = path.join(repoRoot, "src");

/** src 配下の .ts を集める（テストコードは対象外） */
function collectSourceFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "test") {
				continue;
			}
			files.push(...collectSourceFiles(full));
		} else if (entry.name.endsWith(".ts")) {
			files.push(full);
		}
	}
	return files;
}

/** extension.ts が registerCommand している ID */
function registeredCommandIds(): Set<string> {
	const source = fs.readFileSync(path.join(srcRoot, "extension.ts"), "utf8");
	return new Set(Array.from(source.matchAll(/registerCommand\(\s*"([^"]+)"/g), (m) => m[1]));
}

/** VS Code が自動で用意するビューのフォーカスコマンド（package.json の views から） */
function viewFocusCommandIds(): Set<string> {
	const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
		contributes?: { views?: Record<string, Array<{ id: string }>> };
	};
	const ids = new Set<string>();
	for (const views of Object.values(pkg.contributes?.views ?? {})) {
		for (const view of views) {
			ids.add(`${view.id}.focus`);
		}
	}
	return ids;
}

suite("executeCommand で呼ぶコマンドID", () => {
	test("製品コードが呼ぶ mdait.* のコマンドは、すべて登録されている", () => {
		const known = new Set([...registeredCommandIds(), ...viewFocusCommandIds()]);
		const unknown: string[] = [];

		for (const file of collectSourceFiles(srcRoot)) {
			const source = fs.readFileSync(file, "utf8");
			for (const match of source.matchAll(/executeCommand\(\s*"(mdait\.[^"]+)"/g)) {
				if (!known.has(match[1])) {
					unknown.push(`${path.relative(repoRoot, file)}: ${match[1]}`);
				}
			}
		}

		assert.deepEqual(unknown, [], `登録されていないコマンドIDを実行している:\n${unknown.join("\n")}`);
	});
});
