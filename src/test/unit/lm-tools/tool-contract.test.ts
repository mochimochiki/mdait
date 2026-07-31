/**
 * @file tool-contract.test.ts
 * @description
 *   LM Tools のエンベロープ契約（docs/design/tools.md）をソースレベルで固定する契約テスト。
 *   個別ツールの invoke は VS Code 実環境依存が強く単体では実行しづらいため、
 *   「共通エンベロープ経由で応答する」「nextActions の誘導を返す」という契約の
 *   逸脱をソース走査で検出する（かつて mdait_adopt の nextActions 欠落が疑われた際、
 *   これを機械検出する手段がなかったことへの再発防止）。
 * @module test/unit/lm-tools/tool-contract
 */
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

/** リポジトリルート（out/test/unit/lm-tools から4階層上） */
const repoRoot = path.resolve(__dirname, "..", "..", "..", "..");
const lmToolsDir = path.join(repoRoot, "src", "lm-tools");

/** package.json に宣言された LM Tools の実装ファイル一覧 */
function collectToolSources(): Array<{ name: string; content: string }> {
	return fs
		.readdirSync(lmToolsDir)
		.filter((f) => f.endsWith("-tool.ts"))
		.map((f) => ({ name: f, content: fs.readFileSync(path.join(lmToolsDir, f), "utf-8") }));
}

suite("LM Toolsのエンベロープ契約（ソース走査）", () => {
	test("ツール実装ファイル数が package.json の languageModelTools 宣言数と一致する", () => {
		const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf-8"));
		const declared: string[] = (pkg.contributes?.languageModelTools ?? []).map(
			(t: { name: string }) => t.name,
		);
		const sources = collectToolSources();
		assert.strictEqual(
			sources.length,
			declared.length,
			`宣言ツール数(${declared.length})と実装ファイル数(${sources.length})が一致すること: ${declared.join(", ")}`,
		);
	});

	test("全ツールが共通エンベロープ（createOkEnvelope/createErrorEnvelope）で応答する", () => {
		for (const { name, content } of collectToolSources()) {
			assert.ok(content.includes("createOkEnvelope"), `${name}: 成功応答が共通エンベロープを経由すること`);
			assert.ok(content.includes("createErrorEnvelope"), `${name}: エラー応答が共通エンベロープを経由すること`);
			assert.ok(content.includes("toToolResult"), `${name}: 応答が toToolResult で直列化されること`);
		}
	});

	test("全ツールが成功応答に nextActions の誘導を含める", () => {
		// buildNextActions / buildAdoptNextActions / インラインの nextActions 構築のいずれかを参照していること。
		// nextActions はエージェントの観測→行動ループの誘導装置であり、欠落したツールは
		// 「気の利かないエージェント」を行き止まりにする（docs/design/agent-orchestration.md）。
		for (const { name, content } of collectToolSources()) {
			assert.ok(
				/nextActions|NextActions/.test(content),
				`${name}: 成功エンベロープに nextActions を渡していること`,
			);
		}
	});
});
