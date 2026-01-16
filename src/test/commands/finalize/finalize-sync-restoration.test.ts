import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { Configuration } from "../../../config/configuration";
import { sync_CoreProc } from "../../../commands/sync/sync-command";
import { markdownParser } from "../../../core/markdown/parser";

suite("Finalize → Sync → State Restoration", () => {
	const testDir = path.join(__dirname, "../../workspace/finalize-sync-test");
	const sourceFile = path.join(testDir, "source.md");
	const targetFile = path.join(testDir, "target.md");

	setup(() => {
		// テストディレクトリを作成
		if (!fs.existsSync(testDir)) {
			fs.mkdirSync(testDir, { recursive: true });
		}
	});

	teardown(() => {
		// テストファイルを削除
		if (fs.existsSync(sourceFile)) {
			fs.unlinkSync(sourceFile);
		}
		if (fs.existsSync(targetFile)) {
			fs.unlinkSync(targetFile);
		}
	});

	test("finalizeとsyncで翻訳状態が復元される", async () => {
		const config = Configuration.getInstance();

		// 初期状態: ソースファイルとターゲットファイルを作成
		const sourceContent = `<!-- mdait a1b2c3d4 -->
## Heading 1

Source content 1.

<!-- mdait e5f6g7h8 -->
## Heading 2

Source content 2.`;

		const targetContent = `<!-- mdait x1y2z3w4 from:a1b2c3d4 -->
## Heading 1

Target content 1.

<!-- mdait p5q6r7s8 from:e5f6g7h8 -->
## Heading 2

Target content 2.`;

		fs.writeFileSync(sourceFile, sourceContent, "utf-8");
		fs.writeFileSync(targetFile, targetContent, "utf-8");

		// 1. 初期状態を確認 - ターゲットにfromが設定されている
		let targetMarkdown = markdownParser.parse(fs.readFileSync(targetFile, "utf-8"), config);
		assert.equal(targetMarkdown.units.length, 2, "2つのユニットが存在すべき");
		assert.ok(targetMarkdown.units[0].marker.from, "fromフィールドが存在すべき");
		assert.ok(targetMarkdown.units[1].marker.from, "fromフィールドが存在すべき");

		// 2. Finalize: 両方のファイルからマーカーを削除
		const finalizeSource = (content: string): string => {
			const markdown = markdownParser.parse(content, config);
			const resultLines: string[] = [];
			if (markdown.frontMatter && !markdown.frontMatter.isEmpty()) {
				resultLines.push(markdown.frontMatter.raw);
			}
			for (const unit of markdown.units) {
				resultLines.push(unit.content);
			}
			return resultLines.join("\n\n").trimEnd() + "\n";
		};

		const finalizedSource = finalizeSource(sourceContent);
		const finalizedTarget = finalizeSource(targetContent);

		fs.writeFileSync(sourceFile, finalizedSource, "utf-8");
		fs.writeFileSync(targetFile, finalizedTarget, "utf-8");

		// Finalize後の確認 - マーカーが削除されている
		assert.ok(!finalizedSource.includes("<!-- mdait"), "ソースファイルからマーカーが削除されている");
		assert.ok(!finalizedTarget.includes("<!-- mdait"), "ターゲットファイルからマーカーが削除されている");
		assert.ok(finalizedSource.includes("## Heading 1"), "ソースの見出しが保持されている");
		assert.ok(finalizedTarget.includes("## Heading 1"), "ターゲットの見出しが保持されている");

		// 3. Sync: マーカーを再生成
		await sync_CoreProc(sourceFile, targetFile, config);

		// Sync後の確認 - マーカーが再生成されている
		const syncedSource = fs.readFileSync(sourceFile, "utf-8");
		const syncedTarget = fs.readFileSync(targetFile, "utf-8");

		assert.ok(syncedSource.includes("<!-- mdait"), "ソースファイルにマーカーが再生成されている");
		assert.ok(syncedTarget.includes("<!-- mdait"), "ターゲットファイルにマーカーが再生成されている");

		// 4. 状態復元の確認 - fromフィールドとハッシュマッチング
		const restoredSource = markdownParser.parse(syncedSource, config);
		const restoredTarget = markdownParser.parse(syncedTarget, config);

		assert.equal(restoredSource.units.length, 2, "ソースに2つのユニットが復元されている");
		assert.equal(restoredTarget.units.length, 2, "ターゲットに2つのユニットが復元されている");

		// ハッシュが再計算されている
		assert.ok(restoredSource.units[0].marker.hash, "ソースの1番目のユニットにハッシュがある");
		assert.ok(restoredTarget.units[0].marker.hash, "ターゲットの1番目のユニットにハッシュがある");

		// fromフィールドが設定されている
		assert.ok(restoredTarget.units[0].marker.from, "ターゲットの1番目のユニットにfromフィールドが設定されている");
		assert.ok(restoredTarget.units[1].marker.from, "ターゲットの2番目のユニットにfromフィールドが設定されている");

		// ハッシュマッチングでfromとソースのハッシュが一致している（内容が変わっていない場合）
		assert.equal(
			restoredTarget.units[0].marker.from,
			restoredSource.units[0].marker.hash,
			"fromフィールドがソースのハッシュと一致している",
		);
		assert.equal(
			restoredTarget.units[1].marker.from,
			restoredSource.units[1].marker.hash,
			"2番目のfromフィールドもソースのハッシュと一致している",
		);

		// needフラグが設定されていない（内容が変わっていないため）
		assert.ok(!restoredTarget.units[0].marker.need, "翻訳済みのためneedフラグがない");
		assert.ok(!restoredTarget.units[1].marker.need, "翻訳済みのためneedフラグがない");
	});

	test("finalize後にソースが変更された場合、syncでneed:translateが付与される", async () => {
		const config = Configuration.getInstance();

		// 初期状態
		const sourceContent = `<!-- mdait a1b2c3d4 -->
## Heading

Original content.`;

		const targetContent = `<!-- mdait x1y2z3w4 from:a1b2c3d4 -->
## Heading

Translated content.`;

		fs.writeFileSync(sourceFile, sourceContent, "utf-8");
		fs.writeFileSync(targetFile, targetContent, "utf-8");

		// Finalize
		const finalize = (content: string): string => {
			const markdown = markdownParser.parse(content, config);
			const resultLines: string[] = [];
			for (const unit of markdown.units) {
				resultLines.push(unit.content);
			}
			return resultLines.join("\n\n").trimEnd() + "\n";
		};

		fs.writeFileSync(sourceFile, finalize(sourceContent), "utf-8");
		fs.writeFileSync(targetFile, finalize(targetContent), "utf-8");

		// ソース側を変更
		const modifiedSource = `## Heading

Modified content.`;
		fs.writeFileSync(sourceFile, modifiedSource, "utf-8");

		// Sync
		await sync_CoreProc(sourceFile, targetFile, config);

		// 確認: ターゲットにneed:translateが付与されている
		const syncedTarget = fs.readFileSync(targetFile, "utf-8");
		const targetMarkdown = markdownParser.parse(syncedTarget, config);

		assert.equal(targetMarkdown.units.length, 1, "1つのユニットがある");
		assert.equal(
			targetMarkdown.units[0].marker.need,
			"translate",
			"ソースが変更されたためneed:translateが付与されている",
		);
	});
});
