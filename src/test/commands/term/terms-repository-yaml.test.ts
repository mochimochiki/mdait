/**
 * @file terms-repository-yaml.test.ts
 * @description YAMLリポジトリのテスト
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, suite, test } from "mocha";

import { TermEntry } from "../../../commands/term/term-entry";
import { YamlTermsRepository } from "../../../commands/term/terms-repository-yaml";
import type { TransPair } from "../../../config/configuration";

suite("YamlTermsRepository", () => {
	const testDir = path.join(__dirname, "../../workspace/terms");
	const testFilePath = path.join(testDir, "test-terms.yaml");

	const testTransPairs: TransPair[] = [
		{ sourceDir: "src/ja", targetDir: "src/en", sourceLang: "ja", targetLang: "en" },
		{ sourceDir: "src/en", targetDir: "src/de", sourceLang: "en", targetLang: "de" },
	];

	// テスト前にディレクトリとファイルを作成
	if (!fs.existsSync(testDir)) {
		fs.mkdirSync(testDir, { recursive: true });
	}

	test("新しいYAMLリポジトリの作成", async () => {
		const repository = await YamlTermsRepository.create(testFilePath, testTransPairs);

		assert.strictEqual(repository.path, testFilePath);

		const entries = await repository.getAllEntries();
		assert.strictEqual(entries.length, 0);

		const stats = await repository.getStats();
		assert.strictEqual(stats.totalEntries, 0);
	});

	test("用語エントリの追加と保存", async () => {
		const repository = await YamlTermsRepository.create(testFilePath, testTransPairs);

		const entry1 = TermEntry.create("API関連", {
			ja: { term: "API呼び出し", variants: ["API コール"] },
			en: { term: "API call", variants: ["API invoke"] },
		});

		const entry2 = TermEntry.create("文書作成", {
			ja: { term: "マークダウン", variants: ["Markdown"] },
			en: { term: "Markdown", variants: ["MarkDown"] },
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

	test("YAMLファイルからの読み込み", async () => {
		// 先ほど保存したファイルを読み込み
		const repository = await YamlTermsRepository.load(testFilePath);

		const entries = await repository.getAllEntries();
		assert.strictEqual(entries.length, 2);

		// エントリの内容をチェック
		const apiEntry = entries.find((e) => e.context === "API関連");
		assert.ok(apiEntry);
		assert.strictEqual(TermEntry.getTerm(apiEntry, "ja"), "API呼び出し");
		assert.strictEqual(TermEntry.getTerm(apiEntry, "en"), "API call");

		const mdEntry = entries.find((e) => e.context === "文書作成");
		assert.ok(mdEntry);
		assert.strictEqual(TermEntry.getTerm(mdEntry, "ja"), "マークダウン");
		assert.strictEqual(TermEntry.getTerm(mdEntry, "en"), "Markdown");
	});

	test("重複エントリのマージ", async () => {
		const repository = await YamlTermsRepository.load(testFilePath);

		// 既存エントリと重複する新しいエントリ
		const duplicateEntry = TermEntry.create("API関連 - 更新", {
			ja: { term: "API呼び出し", variants: ["API コール", "エーピーアイ呼び出し"] }, // 新しい表記揺れを追加
			de: { term: "API-Aufruf", variants: [] }, // 新しい言語を追加
		});

		await repository.Merge([duplicateEntry], testTransPairs);

		const entries = await repository.getAllEntries();
		assert.strictEqual(entries.length, 2); // エントリ数は変わらない

		// マージされた内容をチェック
		const mergedEntry = entries.find((e) => TermEntry.hasLanguage(e, "de"));
		assert.ok(mergedEntry);
		assert.strictEqual(TermEntry.getTerm(mergedEntry, "de"), "API-Aufruf");
		assert.strictEqual(mergedEntry.context, "API関連 - 更新"); // contextは更新される
	});

	// テスト後のクリーンアップ
	afterEach(() => {
		if (fs.existsSync(testFilePath)) {
			fs.unlinkSync(testFilePath);
		}
	});
});
