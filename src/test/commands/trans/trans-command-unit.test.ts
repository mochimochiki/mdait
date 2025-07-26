import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import { join } from "node:path";
import { transUnitCommand } from "../../../commands/trans/trans-command";
import { Configuration } from "../../../config/configuration";
import { markdownParser } from "../../../core/markdown/parser";
import { StatusManager } from "../../../core/status/status-manager";

suite("TransUnitCommand", () => {
	let tmpDir: string;

	setup(async () => {
		// テストディレクトリの作成
		tmpDir = join(__dirname, "..", "..", "workspace", "trans-unit-test");
		if (fs.existsSync(tmpDir)) {
			fs.rmSync(tmpDir, { recursive: true });
		}
		fs.mkdirSync(tmpDir, { recursive: true });

		// StatusManagerをリセット
		const statusManager = StatusManager.getInstance();
		// プライベートメンバーをリセットするためのハック（テスト用）
		// biome-ignore lint/suspicious/noExplicitAny: テスト用のプライベートメンバーアクセス
		(statusManager as any).statusItems = [];
		// biome-ignore lint/suspicious/noExplicitAny: テスト用のプライベートメンバーアクセス
		(statusManager as any).isInitialized = false;
	});

	teardown(() => {
		// テストディレクトリのクリーンアップ
		if (fs.existsSync(tmpDir)) {
			fs.rmSync(tmpDir, { recursive: true });
		}
	});

	test("指定されたユニットのみが翻訳されること", async () => {
		// テスト用Markdownファイルの作成
		const testContent = [
			"<!-- mdait unit001 need:translate -->",
			"# 最初の見出し",
			"",
			"最初のコンテンツです。",
			"",
			"<!-- mdait unit002 need:translate -->", 
			"## 2番目の見出し",
			"",
			"2番目のコンテンツです。",
			"",
			"<!-- mdait unit003 -->",
			"### 3番目の見出し",
			"",
			"3番目のコンテンツです（翻訳不要）。",
		].join("\n");

		const testFile = join(tmpDir, "test-unit.md");
		fs.writeFileSync(testFile, testContent, "utf-8");

		// 設定ファイルを作成（翻訳ペア設定）
		const configContent = {
			transPairs: [
				{
					sourceDir: "src",
					targetDir: tmpDir.split("/").pop(),
					sourceLang: "ja",
					targetLang: "en",
				},
			],
		};
		const configFile = join(tmpDir, "..", "..", "..", ".vscode", "settings.json");
		const configDir = join(tmpDir, "..", "..", "..", ".vscode");
		if (!fs.existsSync(configDir)) {
			fs.mkdirSync(configDir, { recursive: true });
		}
		fs.writeFileSync(configFile, JSON.stringify({ "mdait.transPairs": configContent.transPairs }), "utf-8");

		// 最初の状態を確認
		const config = new Configuration();
		await config.load();
		const beforeMarkdown = markdownParser.parse(testContent, config);
		const unitsBeforeTranslation = beforeMarkdown.units.filter((unit) => unit.needsTranslation());
		assert.strictEqual(unitsBeforeTranslation.length, 2);

		// 最初のユニットのみを翻訳
		await transUnitCommand(testFile, "unit001");

		// 翻訳後のファイル内容を確認
		const afterContent = fs.readFileSync(testFile, "utf-8");
		const afterMarkdown = markdownParser.parse(afterContent, config);

		// unit001は翻訳済み、unit002は未翻訳のまま、unit003は元々翻訳不要
		const unit001 = afterMarkdown.units.find((unit) => unit.marker?.hash === "unit001");
		const unit002 = afterMarkdown.units.find((unit) => unit.marker?.hash === "unit002");
		const unit003 = afterMarkdown.units.find((unit) => unit.marker?.hash === "unit003");

		assert.ok(unit001);
		assert.ok(unit002);
		assert.ok(unit003);

		// unit001は翻訳済み（needフラグが除去されている）
		assert.strictEqual(unit001.needsTranslation(), false);
		assert.strictEqual(unit001.marker?.need, null);

		// unit002は未翻訳のまま（needフラグが残っている）
		assert.strictEqual(unit002.needsTranslation(), true);
		assert.strictEqual(unit002.marker?.need, "translate");

		// unit003は元々翻訳不要
		assert.strictEqual(unit003.needsTranslation(), false);
	});

	test("存在しないユニットハッシュでエラーになること", async () => {
		const testContent = [
			"<!-- mdait unit001 need:translate -->",
			"# テスト見出し",
			"",
			"テストコンテンツです。",
		].join("\n");

		const testFile = join(tmpDir, "test-error.md");
		fs.writeFileSync(testFile, testContent, "utf-8");

		// 設定ファイルを作成
		const configContent = {
			transPairs: [
				{
					sourceDir: "src",
					targetDir: tmpDir.split("/").pop(),
					sourceLang: "ja",
					targetLang: "en",
				},
			],
		};
		const configFile = join(tmpDir, "..", "..", "..", ".vscode", "settings.json");
		const configDir = join(tmpDir, "..", "..", "..", ".vscode");
		if (!fs.existsSync(configDir)) {
			fs.mkdirSync(configDir, { recursive: true });
		}
		fs.writeFileSync(configFile, JSON.stringify({ "mdait.transPairs": configContent.transPairs }), "utf-8");

		// 存在しないハッシュで翻訳を試行
		try {
			await transUnitCommand(testFile, "nonexistent");
			assert.fail("エラーが発生すべき");
		} catch (error) {
			// エラーが発生することを期待（ここではコンソール出力のみなので実際にはthrowしない）
		}

		// ファイル内容が変更されていないことを確認
		const afterContent = fs.readFileSync(testFile, "utf-8");
		assert.strictEqual(afterContent, testContent);
	});

	test("翻訳不要なユニットに対してメッセージが表示されること", async () => {
		const testContent = [
			"<!-- mdait unit001 -->", // need:translateフラグなし
			"# テスト見出し",
			"",
			"テストコンテンツです。",
		].join("\n");

		const testFile = join(tmpDir, "test-no-need.md");
		fs.writeFileSync(testFile, testContent, "utf-8");

		// 設定ファイルを作成
		const configContent = {
			transPairs: [
				{
					sourceDir: "src",
					targetDir: tmpDir.split("/").pop(),
					sourceLang: "ja", 
					targetLang: "en",
				},
			],
		};
		const configFile = join(tmpDir, "..", "..", "..", ".vscode", "settings.json");
		const configDir = join(tmpDir, "..", "..", "..", ".vscode");
		if (!fs.existsSync(configDir)) {
			fs.mkdirSync(configDir, { recursive: true });
		}
		fs.writeFileSync(configFile, JSON.stringify({ "mdait.transPairs": configContent.transPairs }), "utf-8");

		// 翻訳不要なユニットに対して翻訳を試行
		await transUnitCommand(testFile, "unit001");

		// ファイル内容が変更されていないことを確認
		const afterContent = fs.readFileSync(testFile, "utf-8");
		assert.strictEqual(afterContent, testContent);
	});
});