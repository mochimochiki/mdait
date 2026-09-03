/**
 * ワークスペース全体のレビュー対象の選び方。
 *
 * 原文の無い訳文（孤立訳文）をここに含めると、レビューは「原文が見つからない」と失敗する
 * しかない。その事実は sync が孤立訳文の通知とツリーで既に伝えているので、レビューが
 * エラーとして数え直すと、取り込みの結果が理由の分からない `errors: 1` になる
 * （実測。原文に無い訳文を1本混ぜた見本サイトを実 LLM で取り込んだときの唯一のエラー）。
 */

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { collectWorkspaceReviewTargets } from "../../../../commands/ai-review/review-targets";
import { Configuration } from "../../../../infra/config/configuration";
import { FileExplorer } from "../../../../infra/workspace/file-explorer";

declare let __vscodeMockWorkspaceRoot: string;

suite("レビュー対象の列挙（ワークスペース全体）", () => {
	let tempDir: string;
	setup(() => {
		Configuration.dispose();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-review-targets-"));
		__vscodeMockWorkspaceRoot = tempDir;
		fs.mkdirSync(path.join(tempDir, "ja"), { recursive: true });
		fs.mkdirSync(path.join(tempDir, "en", "legacy"), { recursive: true });
	});

	teardown(() => {
		Configuration.dispose();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	async function initConfig(trans: Record<string, unknown> = {}): Promise<Configuration> {
		const mdaitDir = path.join(tempDir, ".mdait");
		fs.mkdirSync(mdaitDir, { recursive: true });
		const configPath = path.join(mdaitDir, "mdait.json");
		fs.writeFileSync(
			configPath,
			JSON.stringify({
				transPairs: [{ sourceDir: "ja", targetDir: "en", sourceLang: "ja", targetLang: "en" }],
				primaryLang: "ja",
				trans,
			}),
			"utf-8",
		);
		return await Configuration.getInstance().initialize(configPath);
	}

	test("除外パターン（ignoredPatterns）の当たるフォルダを見に行かないこと", async () => {
		// 実コードは `config.ignoredPatterns`（既定 `**/node_modules/**`）を findFiles へ渡す。
		// モックがこれを無視すると、実運用では出てこないファイルを見たままテストが通る
		const config = await initConfig();
		fs.writeFileSync(path.join(tempDir, "ja", "doc.md"), "# 原稿\n", "utf-8");
		fs.writeFileSync(path.join(tempDir, "en", "doc.md"), "# Doc\n", "utf-8");
		fs.mkdirSync(path.join(tempDir, "ja", "node_modules"), { recursive: true });
		fs.mkdirSync(path.join(tempDir, "en", "node_modules"), { recursive: true });
		fs.writeFileSync(path.join(tempDir, "ja", "node_modules", "junk.md"), "# 原稿\n", "utf-8");
		fs.writeFileSync(path.join(tempDir, "en", "node_modules", "junk.md"), "# Junk\n", "utf-8");

		const targets = await collectWorkspaceReviewTargets(config, new FileExplorer());

		assert.deepStrictEqual(
			targets.map((f) => path.relative(tempDir, f)),
			[path.join("en", "doc.md")],
			"除外の当たるフォルダのファイルが混ざっている",
		);
	});

	test("原文のある訳文だけを数え、孤立訳文は外すこと", async () => {
		const config = await initConfig();
		fs.writeFileSync(path.join(tempDir, "ja", "doc.md"), "# 原稿\n", "utf-8");
		fs.writeFileSync(path.join(tempDir, "en", "doc.md"), "# Doc\n", "utf-8");
		// 原文の無い訳文（パターン#8）
		fs.writeFileSync(path.join(tempDir, "en", "legacy", "old-guide.md"), "# Old\n", "utf-8");

		const targets = await collectWorkspaceReviewTargets(config, new FileExplorer());

		assert.deepStrictEqual(
			targets.map((f) => path.relative(tempDir, f)),
			[path.join("en", "doc.md")],
			"孤立訳文がレビュー対象に混ざっている（レビューは原文が無いと失敗するしかない）",
		);
	});

	/**
	 * 非Markdown（`trans.extensions`）もレビューの対象にする。
	 *
	 * 列挙が Markdown だけに閉じていたため、非Markdownは翻訳されるのにレビューだけ素通りし、
	 * 取り込みのあと**確認待ちが人手でしか外れなかった**（実測: 見本サイトの取り込みで
	 * .txt / .csv / .json の3本が残った）。
	 */
	test("管理下の非Markdownも対象に入ること", async () => {
		const config = await initConfig({ extensions: [".txt", ".csv"] });
		for (const [dir, name] of [
			["ja", "doc.md"],
			["en", "doc.md"],
			["ja", "notice.txt"],
			["en", "notice.txt"],
			["ja", "contacts.csv"],
			["en", "contacts.csv"],
		] as const) {
			fs.writeFileSync(path.join(tempDir, dir, name), "body\n", "utf-8");
		}

		const targets = await collectWorkspaceReviewTargets(config, new FileExplorer());

		const names = targets.map((f) => path.basename(f)).sort();
		assert.deepStrictEqual(names, ["contacts.csv", "doc.md", "notice.txt"]);
	});

	test("管理下にない拡張子は対象に入らないこと", async () => {
		const config = await initConfig({ extensions: [".txt"] });
		for (const [dir, name] of [
			["ja", "notice.txt"],
			["en", "notice.txt"],
			["ja", "data.json"],
			["en", "data.json"],
		] as const) {
			fs.writeFileSync(path.join(tempDir, dir, name), "body\n", "utf-8");
		}

		const targets = await collectWorkspaceReviewTargets(config, new FileExplorer());

		assert.deepStrictEqual(
			targets.map((f) => path.basename(f)),
			["notice.txt"],
			"trans.extensions に無い拡張子まで拾っている",
		);
	});
});
