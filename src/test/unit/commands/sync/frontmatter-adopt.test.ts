/**
 * 既存の対訳サイトを取り込むとき、frontmatter の既訳も本文と同じように扱うことの回帰テスト。
 *
 * 背景: 取り込み（adopt）は本文ユニットには `need:review` を付けて trans の上書きから守るが、
 * frontmatter だけはその規則が書かれておらず、`need:translate` のままだった。その結果、
 * **最初の翻訳で人の書いた英語タイトルが機械翻訳に置き換わっていた**（実測）。
 * adopt が掲げる「既訳の不可侵」が本文にしか効いていなかった。
 *
 * その後、規則は取り込みかどうかに依らなくなった（`marker-sync.ts` の `needForFirstLink`）。
 * ふつうの sync でも、マーカーの無い訳文側に値があれば review で受ける。丸写し（対象キーの
 * 値が原文と全部同じ）は本文ユニットと同じく translate に残す — review に倒すと出口が
 * 「確認済みにする」しか無く、原文の複製そのままのファイルは訳されないまま受け入れるしか
 * なくなるため。
 */

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { syncNew_CoreProc, sync_CoreProc } from "../../../../commands/sync/sync-command";
import { parseFrontmatterMarker } from "../../../../core/markdown/frontmatter-translation";
import { markdownParser } from "../../../../core/markdown/parser";
import { UnitRegistryManager } from "../../../../core/unit-registry/unit-registry-manager";
import { UnitStateStore } from "../../../../core/unit-state/unit-state-store";
import { Configuration } from "../../../../infra/config/configuration";
import { resolveMarkerIOForFile } from "../../../../infra/config/marker-io";
import { FileMutex } from "../../../../infra/workspace/file-mutex";

declare let __vscodeMockWorkspaceRoot: string;

const SOURCE = ["---", 'title: "インストール"', 'description: "動作環境と導入手順"', "---", "# インストール", "", "手順を説明します。", ""].join(
	"\n",
);

/** 人が訳した frontmatter を持つ既訳 */
const TARGET = [
	"---",
	'title: "Installation"',
	'description: "Requirements and setup steps"',
	"---",
	"# Installation",
	"",
	"This section describes the installation steps.",
	"",
].join("\n");

for (const mode of ["embedded", "external"] as const) {
	suite(`sync: frontmatter の既訳も取り込む（${mode}）`, () => {
		let tempDir: string;
		let sourceFile: string;
		let targetFile: string;

		setup(() => {
			Configuration.dispose();
			UnitRegistryManager.resetInstance();
			UnitStateStore.dispose();
			FileMutex.dispose();
			tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-fm-adopt-"));
			__vscodeMockWorkspaceRoot = tempDir;
			fs.mkdirSync(path.join(tempDir, "ja"), { recursive: true });
			fs.mkdirSync(path.join(tempDir, "en"), { recursive: true });
			sourceFile = path.join(tempDir, "ja", "doc.md");
			targetFile = path.join(tempDir, "en", "doc.md");
		});

		teardown(() => {
			Configuration.dispose();
			UnitRegistryManager.resetInstance();
			UnitStateStore.dispose();
			FileMutex.dispose();
			fs.rmSync(tempDir, { recursive: true, force: true });
		});

		async function bootstrap(): Promise<Configuration> {
			const mdaitDir = path.join(tempDir, ".mdait");
			fs.mkdirSync(mdaitDir, { recursive: true });
			const configPath = path.join(mdaitDir, "mdait.json");
			fs.writeFileSync(
				configPath,
				JSON.stringify({
					transPairs: [{ sourceDir: "ja", targetDir: "en", sourceLang: "ja", targetLang: "en" }],
					primaryLang: "ja",
					markers: { mode },
					sync: { level: 3 },
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

		/** 訳文側の frontmatter マーカーを読む（保管方式に依らず同じ読み口を通す） */
		function targetFrontmatterMarker() {
			const config = Configuration.getInstance();
			const io = resolveMarkerIOForFile(config, targetFile);
			const doc = markdownParser.parse(fs.readFileSync(targetFile, "utf-8"), config, io.provider, io.ctx);
			return parseFrontmatterMarker(doc.frontMatter);
		}

		test("取り込みで frontmatter が確認待ちになること（翻訳待ちにしない）", async () => {
			const config = await bootstrap();
			fs.writeFileSync(targetFile, TARGET, "utf-8");

			const result = await sync_CoreProc(sourceFile, targetFile, config, { adopt: true });

			const marker = targetFrontmatterMarker();
			assert.strictEqual(marker?.need, "review", "人の書いたタイトルは既訳。訳し直す対象ではない");
			assert.strictEqual(marker?.needsTranslation(), false, "trans の対象に入らないこと");
			assert.ok((result.adopted ?? 0) >= 1, "取り込んだ件数に数えること");
		});

		test("取り込んでも訳文の title / description が書き換わらないこと", async () => {
			const config = await bootstrap();
			fs.writeFileSync(targetFile, TARGET, "utf-8");

			await sync_CoreProc(sourceFile, targetFile, config, { adopt: true });

			const written = fs.readFileSync(targetFile, "utf-8");
			assert.match(written, /title: "Installation"/);
			assert.match(written, /description: "Requirements and setup steps"/);
		});

		test("取り込みでない通常の sync でも、人の書いた frontmatter は確認待ちになること", async () => {
			// かつては adopt を頼まれたときだけ review にしていた。ふつうの sync で translate を付けると
			// 次の trans が人の付けたタイトルを機械翻訳で上書きする — 事故は取り込みかどうかと関係なく起きる
			const config = await bootstrap();
			fs.writeFileSync(targetFile, TARGET, "utf-8");

			const result = await sync_CoreProc(sourceFile, targetFile, config);

			const marker = targetFrontmatterMarker();
			assert.strictEqual(marker?.need, "review", "取り込みの有無に関わらず既訳は守る");
			assert.strictEqual(marker?.needsTranslation(), false, "trans の対象に入らないこと");
			assert.ok((result.adopted ?? 0) >= 1, "既訳として受けた件数に数えること");
			assert.match(fs.readFileSync(targetFile, "utf-8"), /title: "Installation"/, "値は1文字も変えない");
		});

		test("訳文の frontmatter が原文の丸写し（対象キーの値が全部同じ）なら翻訳待ちのままであること", async () => {
			// 本文ユニットと同じ規則。review に倒すと出口が「確認済みにする」しか無く、
			// 原文の複製そのままのファイルは訳されないまま受け入れるしかなくなる
			const config = await bootstrap();
			fs.writeFileSync(
				targetFile,
				[
					"---",
					'title: "インストール"',
					'description: "動作環境と導入手順"',
					"---",
					"# Installation",
					"",
					"Body.",
					"",
				].join("\n"),
				"utf-8",
			);

			await sync_CoreProc(sourceFile, targetFile, config);

			assert.strictEqual(targetFrontmatterMarker()?.need, "translate");
		});

		test("訳文ファイルが無い新規作成では翻訳待ちのままであること（原文の複製は既訳ではない）", async () => {
			const config = await bootstrap();

			await syncNew_CoreProc(sourceFile, targetFile, config);

			assert.strictEqual(targetFrontmatterMarker()?.need, "translate");
		});

		test("訳文に対象キーが無ければ翻訳待ちのままであること", async () => {
			const config = await bootstrap();
			fs.writeFileSync(targetFile, ["---", "draft: false", "---", "# Installation", "", "Body.", ""].join("\n"), "utf-8");

			await sync_CoreProc(sourceFile, targetFile, config, { adopt: true });

			assert.strictEqual(targetFrontmatterMarker()?.need, "translate", "訳す中身が無いのだから翻訳待ちが正しい");
		});

		test("取り込んだあと原文の title が変われば改訂待ちへ移ること", async () => {
			const config = await bootstrap();
			fs.writeFileSync(targetFile, TARGET, "utf-8");
			await sync_CoreProc(sourceFile, targetFile, config, { adopt: true });
			const adoptedFrom = targetFrontmatterMarker()?.from;

			fs.writeFileSync(sourceFile, fs.readFileSync(sourceFile, "utf-8").replace('"インストール"', '"導入"'), "utf-8");
			const revised = await sync_CoreProc(sourceFile, targetFile, config);

			const marker = targetFrontmatterMarker();
			assert.strictEqual(marker?.need, `revise@${adoptedFrom}`, "戻り先つきの改訂待ちが立つこと");
			assert.strictEqual(revised.reviewsSuperseded, 1, "確認待ちから移したことを数えて伝えること");
			assert.match(fs.readFileSync(targetFile, "utf-8"), /title: "Installation"/, "訳文はまだ人の訳のまま");
		});

		test("取り込みを二度流しても結果が変わらないこと（冪等）", async () => {
			const config = await bootstrap();
			fs.writeFileSync(targetFile, TARGET, "utf-8");
			await sync_CoreProc(sourceFile, targetFile, config, { adopt: true });
			const first = fs.readFileSync(targetFile, "utf-8");

			const second = await sync_CoreProc(sourceFile, targetFile, config, { adopt: true });

			assert.strictEqual(fs.readFileSync(targetFile, "utf-8"), first);
			assert.strictEqual(second.adopted ?? 0, 0, "二度目に取り込むものはもう無い");
		});
	});
}
