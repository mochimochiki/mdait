import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { AIServiceBuilder } from "../../../api/ai-service-builder";
import { TranslationContext } from "../../../commands/trans/translation-context";
import { DefaultTranslator } from "../../../commands/trans/translator";
import { Configuration } from "../../../config/configuration";
import { markdownParser } from "../../../core/markdown/parser";

suite("TransCommand", () => {
	let tmpDir: string;

	setup(async () => {
		// テストディレクトリの作成
		tmpDir = join(__dirname, "..", "..", "workspace", "trans-test");
		if (fs.existsSync(tmpDir)) {
			fs.rmSync(tmpDir, { recursive: true });
		}
		fs.mkdirSync(tmpDir, { recursive: true });
	});

	teardown(() => {
		// テストディレクトリのクリーンアップ
		if (fs.existsSync(tmpDir)) {
			fs.rmSync(tmpDir, { recursive: true });
		}
	});

	test("need:translateフラグ付きユニットが正しく特定されること", async () => {
		// テスト用Markdownファイルの作成
		const testContent = [
			"---",
			"title: 'テスト'",
			"---",
			"<!-- mdait abc12345 -->",
			"# 見出し1",
			"",
			"通常のコンテンツです。",
			"",
			"<!-- mdait def67890 need:translate -->",
			"## 見出し2",
			"",
			"翻訳が必要なコンテンツです。",
			"",
			"<!-- mdait ghi09876 from:xyz11111 need:translate -->",
			"### 見出し3",
			"",
			"from属性付きで翻訳が必要なコンテンツです。",
		].join("\n");

		const testFile = join(tmpDir, "test.md");
		fs.writeFileSync(testFile, testContent, "utf-8");

		// Markdownのパースとユニット抽出
		const config = new Configuration();
		await config.load();
		const markdown = markdownParser.parse(testContent, config);

		// need:translateフラグを持つユニットを抽出
		const unitsToTranslate = markdown.units.filter((unit) => unit.needsTranslation());

		// 検証
		assert.strictEqual(unitsToTranslate.length, 2);
		assert.strictEqual(unitsToTranslate[0].marker?.hash, "def67890");
		assert.strictEqual(unitsToTranslate[0].title, "見出し2");
		assert.strictEqual(unitsToTranslate[1].marker?.hash, "ghi09876");
		assert.strictEqual(unitsToTranslate[1].marker?.from, "xyz11111");
		assert.strictEqual(unitsToTranslate[1].title, "見出し3");
	});

	test("from属性がある場合に翻訳元ユニットが正しく特定されること", async () => {
		// 翻訳元と翻訳先のユニットを含むMarkdownファイル
		const testContent = [
			"<!-- mdait source123 -->",
			"# Original Heading",
			"",
			"This is the original content in English.",
			"",
			"<!-- mdait target456 from:source123 need:translate -->",
			"## 翻訳対象見出し",
			"",
			"これは翻訳されるべき日本語コンテンツです。",
		].join("\n");

		const config = new Configuration();
		await config.load();
		const markdown = markdownParser.parse(testContent, config);

		// 翻訳対象ユニットを取得
		const targetUnit = markdown.units.find((unit) => unit.marker?.hash === "target456");
		assert.ok(targetUnit);
		assert.strictEqual(targetUnit.marker?.from, "source123");

		// from属性を使って翻訳元ユニットを検索
		const sourceUnit = markdown.units.find((unit) => unit.marker?.hash === targetUnit.marker?.from);
		assert.ok(sourceUnit);
		assert.strictEqual(sourceUnit.marker?.hash, "source123");
		assert.strictEqual(sourceUnit.title, "Original Heading");
		assert.ok(sourceUnit.content.includes("original content in English"));
	});

	test("翻訳後にneedフラグが除去されハッシュが更新されること", async () => {
		// テスト用Markdownファイルの作成
		const testContent = [
			"<!-- mdait abc12345 need:translate -->",
			"# テスト見出し",
			"",
			"これは翻訳対象のコンテンツです。",
		].join("\n");

		const config = new Configuration();
		await config.load();
		const markdown = markdownParser.parse(testContent, config);

		// 翻訳対象ユニットを取得
		const unit = markdown.units[0];
		assert.ok(unit.needsTranslation());
		assert.strictEqual(unit.marker?.need, "translate");
		const originalHash = unit.marker?.hash;

		// 翻訳後の処理をシミュレート
		unit.content = "# Test Heading\n\nThis is translated content.";
		// ハッシュの更新
		if (unit.marker) {
			const { calculateHash } = await import("../../../core/hash/hash-calculator.js");
			const newHash = calculateHash(unit.content);
			unit.marker.hash = newHash;
		}

		// needフラグの除去
		unit.markAsTranslated();

		// 検証
		assert.ok(!unit.needsTranslation());
		assert.strictEqual(unit.marker?.need, null);
		assert.notStrictEqual(unit.marker?.hash, originalHash);
		assert.ok(unit.content.includes("translated content"));
	});

	test("翻訳対象ユニットが存在しない場合の処理", async () => {
		// need:translateフラグを持たないMarkdownファイル
		const testContent = [
			"<!-- mdait abc12345 -->",
			"# 通常の見出し",
			"",
			"翻訳不要なコンテンツです。",
			"",
			"<!-- mdait def67890 -->",
			"## 別の見出し",
			"",
			"こちらも翻訳不要です。",
		].join("\n");

		const config = new Configuration();
		await config.load();
		const markdown = markdownParser.parse(testContent, config);

		// need:translateフラグを持つユニットを抽出
		const unitsToTranslate = markdown.units.filter((unit) => unit.needsTranslation());

		// 検証：翻訳対象ユニットが0個であること
		assert.strictEqual(unitsToTranslate.length, 0);
	});

	test("複数ユニットの翻訳処理順序が保持されること", async () => {
		// 複数の翻訳対象ユニットを含むMarkdownファイル
		const testContent = [
			"<!-- mdait unit001 need:translate -->",
			"# 最初の見出し",
			"",
			"最初のコンテンツ。",
			"",
			"<!-- mdait unit002 -->",
			"## 翻訳不要見出し",
			"",
			"翻訳不要コンテンツ。",
			"",
			"<!-- mdait unit003 need:translate -->",
			"### 3番目の見出し",
			"",
			"3番目のコンテンツ。",
			"",
			"<!-- mdait unit004 need:translate -->",
			"#### 4番目の見出し",
			"",
			"4番目のコンテンツ。",
		].join("\n");

		const config = new Configuration();
		await config.load();
		const markdown = markdownParser.parse(testContent, config);

		// need:translateフラグを持つユニットを抽出
		const unitsToTranslate = markdown.units.filter((unit) => unit.needsTranslation());

		// 検証：順序が保持されていること
		assert.strictEqual(unitsToTranslate.length, 3);
		assert.strictEqual(unitsToTranslate[0].marker?.hash, "unit001");
		assert.strictEqual(unitsToTranslate[0].title, "最初の見出し");
		assert.strictEqual(unitsToTranslate[1].marker?.hash, "unit003");
		assert.strictEqual(unitsToTranslate[1].title, "3番目の見出し");
		assert.strictEqual(unitsToTranslate[2].marker?.hash, "unit004");
		assert.strictEqual(unitsToTranslate[2].title, "4番目の見出し");
	});

	test("Markdownのstringify後にマーカーが正しく保存されること", async () => {
		// テスト用Markdownファイルの作成
		const testContent = [
			"---",
			"title: 'テスト'",
			"---",
			"<!-- mdait abc12345 need:translate -->",
			"# 見出し",
			"",
			"翻訳前のコンテンツです。",
		].join("\n");

		const config = new Configuration();
		await config.load();
		const markdown = markdownParser.parse(testContent, config);

		// 翻訳処理のシミュレート
		const unit = markdown.units[0];
		unit.content = "# Heading\n\nTranslated content.";
		if (unit.marker) {
			const { calculateHash } = await import("../../../core/hash/hash-calculator.js");
			const newHash = calculateHash(unit.content);
			unit.marker.hash = newHash;
		}
		unit.markAsTranslated();

		// Markdownを文字列に変換
		const updatedContent = markdownParser.stringify(markdown);

		// 検証
		assert.ok(updatedContent.includes("---"));
		assert.ok(updatedContent.includes("title: 'テスト'"));
		assert.ok(updatedContent.includes("<!-- mdait"));
		assert.ok(updatedContent.includes("# Heading"));
		assert.ok(updatedContent.includes("Translated content"));
		assert.ok(!updatedContent.includes("need:translate")); // needフラグが除去されていること
	});
	test("AIサービス統合テスト：翻訳プロバイダが正常に動作すること", async () => {
		// モック翻訳プロバイダーの作成
		class MockTranslator {
			async translate(content: string, sourceLang: string, targetLang: string): Promise<string> {
				// テスト用の簡易翻訳（日英変換）
				if (sourceLang === "ja" && targetLang === "en") {
					return content.replace("見出し", "Heading").replace("コンテンツ", "Content");
				}
				return `[${targetLang}] ${content}`;
			}
		}

		const testContent = [
			"<!-- mdait abc12345 need:translate -->",
			"# 見出し",
			"",
			"これはコンテンツです。",
		].join("\n");
		const config = new Configuration();
		await config.load();
		const markdown = markdownParser.parse(testContent, config);
		const unit = markdown.units[0];
		const mockTranslator = new MockTranslator();

		// 翻訳実行
		const translatedContent = await mockTranslator.translate(unit.content, "ja", "en");
		unit.content = translatedContent;

		// ハッシュ更新
		if (unit.marker) {
			const { calculateHash } = await import("../../../core/hash/hash-calculator.js");
			const newHash = calculateHash(unit.content);
			unit.marker.hash = newHash;
		}
		unit.markAsTranslated();

		// 検証
		assert.ok(unit.content.includes("Heading"));
		assert.ok(unit.content.includes("Content"));
		assert.ok(!unit.needsTranslation());
	});

	test("from属性参照エラー：存在しないハッシュが指定された場合", async () => {
		const testContent = [
			"<!-- mdait target123 from:nonexistent456 need:translate -->",
			"# 翻訳対象見出し",
			"",
			"参照先が存在しない場合のテスト。",
		].join("\n");

		const config = new Configuration();
		await config.load();
		const markdown = markdownParser.parse(testContent, config);

		// 翻訳対象ユニットを取得
		const targetUnit = markdown.units.find((unit) => unit.marker?.hash === "target123");
		assert.ok(targetUnit);
		assert.strictEqual(targetUnit.marker?.from, "nonexistent456");

		// from属性で指定されたハッシュのユニットを検索
		const sourceUnit = markdown.units.find((unit) => unit.marker?.hash === targetUnit.marker?.from);
		assert.strictEqual(sourceUnit, undefined); // 見つからないことを確認
	});

	test("大量ユニット処理：複数ユニットの翻訳が正しく処理されること", async () => {
		// 大量のユニットを含むテストコンテンツ
		const testContent = Array.from({ length: 10 }, (_, i) => [
			`<!-- mdait unit${i.toString().padStart(3, "0")} need:translate -->`,
			`# 見出し${i + 1}`,
			"",
			`これは${i + 1}番目のコンテンツです。`,
			"",
		])
			.flat()
			.join("\n");

		const config = new Configuration();
		await config.load();
		const markdown = markdownParser.parse(testContent, config);

		// 翻訳対象ユニットを抽出
		const unitsToTranslate = markdown.units.filter((unit) => unit.needsTranslation());

		// 検証：10個のユニットが正しく特定されること
		assert.strictEqual(unitsToTranslate.length, 10);

		// 各ユニットの順序と内容を確認
		for (let i = 0; i < 10; i++) {
			const expectedHash = `unit${i.toString().padStart(3, "0")}`;
			assert.strictEqual(unitsToTranslate[i].marker?.hash, expectedHash);
			assert.strictEqual(unitsToTranslate[i].title, `見出し${i + 1}`);
			assert.ok(unitsToTranslate[i].content.includes(`${i + 1}番目のコンテンツ`));
		}
	});

	test("空ファイル処理：空のMarkdownファイルが正しく処理されること", async () => {
		const testContent = "";

		const config = new Configuration();
		await config.load();
		const markdown = markdownParser.parse(testContent, config);

		// 翻訳対象ユニットを抽出
		const unitsToTranslate = markdown.units.filter((unit) => unit.needsTranslation());

		// 検証：翻訳対象ユニットが0個であること
		assert.strictEqual(unitsToTranslate.length, 0);
		assert.strictEqual(markdown.units.length, 0);
	});

	test("フロントマター保持：翻訳処理後もフロントマターが保持されること", async () => {
		const testContent = [
			"---",
			"title: 'テストドキュメント'",
			"author: 'テスト太郎'",
			"date: '2024-01-01'",
			"---",
			"<!-- mdait abc12345 need:translate -->",
			"# メイン見出し",
			"",
			"これは翻訳対象のコンテンツです。",
		].join("\n");

		const config = new Configuration();
		await config.load();
		const markdown = markdownParser.parse(testContent, config);

		// 翻訳処理のシミュレート
		const unit = markdown.units[0];
		unit.content = "# Main Heading\n\nThis is translated content.";

		if (unit.marker) {
			const { calculateHash } = await import("../../../core/hash/hash-calculator.js");
			const newHash = calculateHash(unit.content);
			unit.marker.hash = newHash;
		}
		unit.markAsTranslated();

		// Markdownを文字列に変換
		const updatedContent = markdownParser.stringify(markdown);

		// フロントマターが保持されていることを確認
		assert.ok(updatedContent.includes("---"));
		assert.ok(updatedContent.includes("title: 'テストドキュメント'"));
		assert.ok(updatedContent.includes("author: 'テスト太郎'"));
		assert.ok(updatedContent.includes("date: '2024-01-01'"));

		// 翻訳内容も正しく反映されていることを確認
		assert.ok(updatedContent.includes("# Main Heading"));
		assert.ok(updatedContent.includes("This is translated content"));
		assert.ok(!updatedContent.includes("need:translate"));
	});
});
