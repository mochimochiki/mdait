/**
 * @file managed-write-only.test.ts
 * @description 管理下の原稿（訳文・原文のファイル本体）を書き換える経路が、
 * 必ず `infra/workspace/managed-write.ts` を通ることを、ソースを走査して固定する。
 *
 * 素の `writeFile` で書くと2つの壊れ方が起きる。どちらも無言で、テストの
 * 「内容が同じ」という比較では捕まらない。
 *
 * 1. **改行のくせが失われる**: `stringify` はどんな原稿からでも LF 連結・末尾改行1つで
 *    書き出す。Windows で書かれた（CRLF の）訳文は書き出しのたびに全行 LF へ変わり、
 *    内容が1文字も変わっていないのにファイル全体が差分になる（実測。ADR-260902-01）。
 *    原稿を預ける相手にとっては「勝手に書き換わった」ことに変わりはない。
 * 2. **同じでも書いてしまう**: 保存イベントが空回りし、`autoSyncOnSave` が無駄に走る。
 *
 * 書き出し口は散らばりやすい。実測では ADR-260902-01 で8か所を1つへ寄せた直後にも、
 * AI 翻訳レビューの承認だけが素の `vscode.workspace.fs.writeFile` で書き続けていた。
 * 呼び出し側の単体テストでは見張れない（LF の見本では差が出ない）ため、
 * `unit-state-lock-order.test.ts` と同じくソースを突き合わせる。
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

/** リポジトリのルート（out/test/unit/infra/workspace から5つ上） */
const repoRoot = path.resolve(__dirname, "..", "..", "..", "..", "..");
const srcRoot = path.join(repoRoot, "src");

/**
 * 素の書き出しを許すファイル。**管理下の原稿を書かない**ものだけを並べる。
 * ここへ足すときは「そのファイルが原稿ではない」ことを理由に書くこと。
 */
const ALLOWED = new Map<string, string>([
	["infra/workspace/managed-write.ts", "唯一の入口そのもの"],
	["infra/workspace/atomic-write.ts", "一時ファイル経由の置換。原稿ではなく .mdait/ の管理ファイル向け"],
	["infra/workspace/mdait-dir.ts", ".mdait/ の .gitignore と .gitattributes"],
	["infra/debug/debug-command-handler.ts", "lab の合図ファイル（.mdait/debug/）。製品の経路ではない"],
	["core/unit-registry/unit-registry-manager.ts", ".mdait/ の管理ファイル（unit-registry）"],
	["commands/shared/report-file.ts", ".mdait/reports/ の実行レポート。原稿ではない"],
	["commands/markers/markers-migration.ts", "mdait.json（設定ファイル）の markers.mode を書き換えるだけ"],
	["commands/setup/setup-command.ts", "mdait.json をひな形から作る"],
	["ui/settings/settings-panel.ts", "mdait.json を設定画面から書き換える"],
	[
		"commands/file-handler/plain-file-handler.ts",
		"Markdown 以外の管理下ファイル（.txt / .csv / .json）。改行のくせは同じ問題を抱えるが、ADR-260902-01 の範囲外",
	],
]);

/** 素の書き出しと読めるもの */
const RAW_WRITE = /\b(?:vscode\.workspace\.fs\.writeFile|fs\.writeFileSync|fs\.promises\.writeFile)\s*\(/;

/** src 以下の .ts を集める（テストは対象外） */
function collectSources(dir: string, found: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const abs = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "test") {
				continue;
			}
			collectSources(abs, found);
		} else if (entry.name.endsWith(".ts")) {
			found.push(abs);
		}
	}
	return found;
}

/** 行コメント・ブロックコメントを落とす（説明文の中の writeFile を数えないため） */
function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

suite("管理下の原稿の書き出しは唯一の入口を通る（ADR-260902-01）", () => {
	test("許可した一覧の外に、素の writeFile で書く経路が無い", () => {
		const offenders: string[] = [];
		for (const abs of collectSources(srcRoot)) {
			const rel = path.relative(srcRoot, abs).split(path.sep).join("/");
			if (ALLOWED.has(rel)) {
				continue;
			}
			if (RAW_WRITE.test(stripComments(fs.readFileSync(abs, "utf-8")))) {
				offenders.push(rel);
			}
		}
		assert.deepStrictEqual(
			offenders,
			[],
			`素の writeFile で書く経路が増えている: ${offenders.join(", ")}\n管理下の原稿なら infra/workspace/managed-write.ts の writeManagedMarkdown を通すこと。原稿でないなら、その理由を添えてこのテストの ALLOWED へ足すこと。`,
		);
	});

	test("許可した一覧に、もう素の writeFile を持たないファイルが残っていない", () => {
		const stale: string[] = [];
		for (const [rel] of ALLOWED) {
			const abs = path.join(srcRoot, rel);
			if (!fs.existsSync(abs)) {
				stale.push(`${rel}（ファイルが無い）`);
				continue;
			}
			if (rel === "infra/workspace/managed-write.ts") {
				continue;
			}
			if (!RAW_WRITE.test(stripComments(fs.readFileSync(abs, "utf-8")))) {
				stale.push(`${rel}（素の writeFile が無い）`);
			}
		}
		assert.deepStrictEqual(stale, [], `許可の一覧が実態と合っていない: ${stale.join(", ")}`);
	});
});
