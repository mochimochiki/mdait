/**
 * @file terms-repository-csv.test.ts
 * @description CSVリポジトリのテスト
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, suite, test } from "mocha";

import { TermEntry } from "../../../commands/term/term-entry";
import { TermsRepositoryCSV } from "../../../commands/term/terms-repository-csv";
import type { TransPair } from "../../../config/configuration";

suite("TermsRepositoryCSV", () => {
	const testDir = path.join(__dirname, "../../workspace/terms");
	const testFilePath = path.join(testDir, "test-terms.csv");

	const testTransPairs: TransPair[] = [
		{ sourceDir: "src/ja", targetDir: "src/en", sourceLang: "ja", targetLang: "en" },
		{ sourceDir: "src/en", targetDir: "src/de", sourceLang: "en", targetLang: "de" },
	];

	// テスト前にディレクトリを作成
	if (!fs.existsSync(testDir)) {
		fs.mkdirSync(testDir, { recursive: true });
	}

	afterEach(() => {
		// テストファイルをクリーンアップ
		if (fs.existsSync(testFilePath)) {
			fs.unlinkSync(testFilePath);
		}
	});

	test("新しいCSVリポジトリの作成", async () => {
		const repository = await TermsRepositoryCSV.create(testFilePath, testTransPairs);

		assert.strictEqual(repository.path, testFilePath);

		const entries = await repository.getAllEntries();
		assert.strictEqual(entries.length, 0);

		const stats = await repository.getStats();
		assert.strictEqual(stats.totalEntries, 0);
	});

	test("用語エントリの追加と保存", async () => {
		const repository = await TermsRepositoryCSV.create(testFilePath, testTransPairs);

		const entry1 = TermEntry.create("API関連", {
			ja: { term: "API呼び出し", variants: ["API コール"] },
			en: { term: "API call", variants: [] },
		});

		const entry2 = TermEntry.create("文書作成", {
			ja: { term: "マークダウン", variants: ["Markdown"] },
			en: { term: "Markdown", variants: [] },
		});

		await repository.Merge([entry1, entry2], testTransPairs);
		await repository.save();

		// ファイルが作成されたことを確認
		assert.ok(fs.existsSync(testFilePath));

		// 統計情報をチェック
		const stats = await repository.getStats();
		assert.strictEqual(stats.totalEntries, 2);
		assert.strictEqual(stats.entriesByLanguage.ja, 2);
		assert.strictEqual(stats.entriesByLanguage.en, 2);
	});

	test("CSVファイルからの読み込み", async () => {
		// まず保存
		const repository1 = await TermsRepositoryCSV.create(testFilePath, testTransPairs);
		const entry1 = TermEntry.create("API関連", {
			ja: { term: "API呼び出し", variants: ["API コール"] },
			en: { term: "API call", variants: [] },
		});
		await repository1.Merge([entry1], testTransPairs);
		await repository1.save();

		// 読み込み
		const repository2 = await TermsRepositoryCSV.load(testFilePath);

		const entries = await repository2.getAllEntries();
		assert.strictEqual(entries.length, 1);

		// エントリの内容をチェック
		const apiEntry = entries[0];
		assert.strictEqual(apiEntry.context, "API関連");
		assert.strictEqual(TermEntry.getTerm(apiEntry, "ja"), "API呼び出し");
		assert.strictEqual(TermEntry.getTerm(apiEntry, "en"), "API call");
	});

	test("重複エントリのマージ", async () => {
		// まず保存
		const repository1 = await TermsRepositoryCSV.create(testFilePath, testTransPairs);
		const entry1 = TermEntry.create("API関連", {
			ja: { term: "API呼び出し", variants: ["API コール"] },
			en: { term: "API call", variants: [] },
		});
		await repository1.Merge([entry1], testTransPairs);
		await repository1.save();

		// 読み込み
		const repository2 = await TermsRepositoryCSV.load(testFilePath);

		// 既存エントリと重複する新しいエントリ（新しい言語を追加）
		const duplicateEntry = TermEntry.create("API関連", {
			ja: { term: "API呼び出し", variants: ["API コール", "エーピーアイ呼び出し"] },
			de: { term: "API-Aufruf", variants: [] },
		});

		await repository2.Merge([duplicateEntry], testTransPairs);

		const entries = await repository2.getAllEntries();
		assert.strictEqual(entries.length, 1); // エントリ数は変わらない

		// マージされた内容をチェック
		const apiEntry = entries[0];
		assert.strictEqual(apiEntry.context, "API関連");
		assert.strictEqual(TermEntry.getTerm(apiEntry, "ja"), "API呼び出し");
		assert.strictEqual(TermEntry.getTerm(apiEntry, "en"), "API call");
		assert.strictEqual(TermEntry.getTerm(apiEntry, "de"), "API-Aufruf");
	});

	test("列順序の保持 - 既存ファイル編集時", async () => {
		// Step 1: 初期ファイルを作成（ja, en, context, variants_ja, variants_en の順序）
		const repository1 = await TermsRepositoryCSV.create(testFilePath, testTransPairs);
		const entry1 = TermEntry.create("テスト", {
			ja: { term: "用語A", variants: ["表記A"] },
			en: { term: "Term A", variants: [] },
		});
		await repository1.Merge([entry1], testTransPairs);
		await repository1.save();

		// 初期の列順序を確認
		const content1 = fs.readFileSync(testFilePath, "utf8");
		const lines1 = content1.split(/\r?\n/);
		const headers1 = lines1[0].replace(/^\uFEFF/, ""); // BOM除去
		console.log("初期の列順序:", headers1);

		// Step 2: ファイルを読み込んでマージ
		const repository2 = await TermsRepositoryCSV.load(testFilePath);
		const entry2 = TermEntry.create("テスト", {
			ja: { term: "用語A", variants: ["表記A", "表記B"] },
			en: { term: "Term A", variants: [] },
		});
		await repository2.Merge([entry2], testTransPairs);
		await repository2.save();

		// Step 3: 列順序が変わっていないことを確認
		const content2 = fs.readFileSync(testFilePath, "utf8");
		const lines2 = content2.split(/\r?\n/);
		const headers2 = lines2[0].replace(/^\uFEFF/, ""); // BOM除去
		console.log("マージ後の列順序:", headers2);

		assert.strictEqual(headers1, headers2, "列順序が変わってはいけない");
	});

	test("列順序の保持 - 新しい言語列の追加", async () => {
		// Step 1: 初期ファイルを作成（ja, en のみ）
		const initialTransPairs: TransPair[] = [
			{ sourceDir: "src/ja", targetDir: "src/en", sourceLang: "ja", targetLang: "en" },
		];
		const repository1 = await TermsRepositoryCSV.create(testFilePath, initialTransPairs);
		const entry1 = TermEntry.create("テスト", {
			ja: { term: "用語A", variants: ["表記A"] },
			en: { term: "Term A", variants: [] },
		});
		await repository1.Merge([entry1], initialTransPairs);
		await repository1.save();

		// 初期の列順序を確認
		const content1 = fs.readFileSync(testFilePath, "utf8");
		const lines1 = content1.split(/\r?\n/);
		const headers1 = lines1[0].replace(/^\uFEFF/, "").split(",");
		console.log("初期の列順序:", headers1);

		// Step 2: ファイルを読み込んで新しい言語（de）を追加
		const repository2 = await TermsRepositoryCSV.load(testFilePath);
		const entry2 = TermEntry.create("テスト", {
			ja: { term: "用語A", variants: ["表記A"] },
			en: { term: "Term A", variants: [] },
			de: { term: "Begriff A", variants: [] },
		});

		const newTransPairs: TransPair[] = [
			{ sourceDir: "src/ja", targetDir: "src/en", sourceLang: "ja", targetLang: "en" },
			{ sourceDir: "src/en", targetDir: "src/de", sourceLang: "en", targetLang: "de" },
		];
		await repository2.Merge([entry2], newTransPairs);
		await repository2.save();

		// Step 3: 新しい列が適切な位置に追加されていることを確認
		const content2 = fs.readFileSync(testFilePath, "utf8");
		const lines2 = content2.split(/\r?\n/);
		const headers2 = lines2[0].replace(/^\uFEFF/, "").split(",");
		console.log("新言語追加後の列順序:", headers2);

		// 元の列の順序は保持されているはず
		const contextIndex1 = headers1.indexOf("context");
		const contextIndex2 = headers2.indexOf("context");
		assert.ok(contextIndex2 >= contextIndex1, "contextの位置は後ろに移動するかそのまま");

		// 新しい言語列（de）はcontextの前に追加されているはず
		const deIndex = headers2.indexOf("de");
		assert.ok(deIndex >= 0, "de列が追加されている");
		assert.ok(deIndex < contextIndex2, "de列はcontextの前にある");

		// variants_enはcontextの後にあるはず
		const variantsEnIndex = headers2.indexOf("variants_en");
		assert.ok(variantsEnIndex > contextIndex2, "variants_enはcontextの後にある");
	});
});
