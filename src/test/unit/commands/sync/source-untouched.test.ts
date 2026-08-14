/**
 * external マーカーで同期しても原文が1バイトも変わらないことのテスト
 * （roadmap-v01 の P05 / ADR-260802-04 のゴールそのもの）。
 *
 * external を選ぶ理由は「原稿に mdait の痕跡を残さない」ことなので、原文が書き換わった時点で
 * その約束は破れている。本文のマーカーは既に外部化されているが、frontmatter のマーカー
 * （`mdait.front`）だけは原文に書き込まれ続けていた。
 *
 * 見るのはバイト列である。「マーカーが無いこと」を見ると、空行の入れ方や改行コードが
 * 変わる形の書き換えを見逃す。原文を預ける相手（ライター・翻訳会社）にとっては、
 * どんな変化であれ「勝手に書き換わった」ことに変わりはない。
 */

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { syncNew_CoreProc, sync_CoreProc } from "../../../../commands/sync/sync-command";
import { UnitRegistryManager } from "../../../../core/unit-registry/unit-registry-manager";
import { UnitStateStore } from "../../../../core/unit-state/unit-state-store";
import { Configuration } from "../../../../infra/config/configuration";

declare let __vscodeMockWorkspaceRoot: string;

/** frontmatter に翻訳対象キー（title）を持つ原文。frontmatter マーカーが付く条件 */
const SOURCE = [
	"---",
	"title: 手引き",
	"draft: false",
	"---",
	"",
	"# 手引き",
	"",
	"導入の本文。",
	"",
	"## 第1章",
	"",
	"第1章の本文。",
	"",
].join("\n");

suite("sync: external で原文を書き換えない", () => {
	let tempDir: string;
	let sourceFile: string;
	let targetFile: string;

	setup(() => {
		Configuration.dispose();
		UnitRegistryManager.resetInstance();
		UnitStateStore.dispose();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-src-untouched-"));
		__vscodeMockWorkspaceRoot = tempDir;
		sourceFile = path.join(tempDir, "ja", "doc.md");
		targetFile = path.join(tempDir, "en", "doc.md");
		fs.mkdirSync(path.join(tempDir, "ja"), { recursive: true });
		fs.mkdirSync(path.join(tempDir, "en"), { recursive: true });
	});

	teardown(() => {
		Configuration.dispose();
		UnitRegistryManager.resetInstance();
		UnitStateStore.dispose();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	async function bootstrap(mode: "embedded" | "external"): Promise<Configuration> {
		const mdaitDir = path.join(tempDir, ".mdait");
		fs.mkdirSync(mdaitDir, { recursive: true });
		const configPath = path.join(mdaitDir, "mdait.json");
		fs.writeFileSync(
			configPath,
			JSON.stringify({
				transPairs: [{ sourceDir: "ja", targetDir: "en", sourceLang: "ja", targetLang: "en" }],
				primaryLang: "ja",
				markers: { mode },
				trans: { frontmatter: { keys: ["title", "description"] } },
			}),
			"utf-8",
		);
		const config = Configuration.getInstance();
		await config.initialize(configPath);
		UnitStateStore.getInstance().load(mdaitDir);
		fs.writeFileSync(sourceFile, SOURCE, "utf-8");
		return config;
	}

	test("初期同期で原文のバイト列が変わらないこと", async () => {
		const config = await bootstrap("external");
		const before = fs.readFileSync(sourceFile);

		await syncNew_CoreProc(sourceFile, targetFile, config);

		assert.strictEqual(fs.readFileSync(sourceFile, "utf-8"), before.toString("utf-8"));
	});

	test("2回目以降の同期でも原文のバイト列が変わらないこと", async () => {
		const config = await bootstrap("external");
		await syncNew_CoreProc(sourceFile, targetFile, config);
		const before = fs.readFileSync(sourceFile);

		await sync_CoreProc(sourceFile, targetFile, config);
		await sync_CoreProc(sourceFile, targetFile, config);

		assert.strictEqual(fs.readFileSync(sourceFile, "utf-8"), before.toString("utf-8"));
	});

	test("frontmatter の翻訳状態が失われないこと（書き換えないことと引き換えにしない）", async () => {
		const config = await bootstrap("external");
		await syncNew_CoreProc(sourceFile, targetFile, config);

		// 原文には出ないが、状態そのものはどこかに残っていなければならない。
		// 残っていなければ「原文を汚さない」と「訳文の確認を促す」が両立していない。
		const rows = UnitStateStore.getInstance().getAllEntries();
		assert.ok(
			rows.some((entry) => entry.path === "en/doc.md" && entry.need === "translate"),
			"訳文側に frontmatter の翻訳状態が残っていること",
		);
	});

	test("embedded では従来どおり原文にマーカーが入ること（外部化が embedded に波及しない）", async () => {
		const config = await bootstrap("embedded");

		await syncNew_CoreProc(sourceFile, targetFile, config);

		assert.match(fs.readFileSync(sourceFile, "utf-8"), /front:/);
	});
});
