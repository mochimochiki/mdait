/**
 * @file terms-cache-manager.test.ts
 * @description TermsCacheManagerのテスト実装
 * mtimeベースのキャッシュ管理ロジックの検証
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, suite, test } from "mocha";

import { TermEntry } from "../../../commands/term/term-entry";
import { TermsRepositoryCSV } from "../../../commands/term/terms-repository-csv";
import { TermsCacheManager } from "../../../commands/trans/terms-cache-manager";
import type { TransPair } from "../../../config/configuration";

suite("TermsCacheManager", () => {
	const testDir = path.join(__dirname, "../../workspace/terms");
	const testFilePath = path.join(testDir, "test-cache-terms.csv");

	const testTransPairs: TransPair[] = [
		{ sourceDir: "src/ja", targetDir: "src/en", sourceLang: "ja", targetLang: "en" },
	];

	// テスト前にディレクトリを作成
	if (!fs.existsSync(testDir)) {
		fs.mkdirSync(testDir, { recursive: true });
	}

	afterEach(() => {
		// インスタンスクリア
		TermsCacheManager.dispose();

		// テストファイルをクリーンアップ
		if (fs.existsSync(testFilePath)) {
			fs.unlinkSync(testFilePath);
		}
	});

	test("シングルトンインスタンスが正しく取得できる", () => {
		const instance1 = TermsCacheManager.getInstance();
		const instance2 = TermsCacheManager.getInstance();

		assert.strictEqual(instance1, instance2);
	});

	test("ファイルが存在しない場合は空配列を返す", async () => {
		const manager = TermsCacheManager.getInstance();
		const nonExistentPath = path.join(testDir, "non-existent.csv");

		const terms = await manager.getTerms(nonExistentPath, testTransPairs);

		assert.strictEqual(terms.length, 0);
	});

	test("初回読み込みでキャッシュを構築できる", async () => {
		// テストファイルを準備
		const repository = await TermsRepositoryCSV.create(testFilePath, testTransPairs);
		const entry = TermEntry.create("テスト", {
			ja: { term: "開発プロセス", variants: [] },
			en: { term: "development process", variants: [] },
		});
		await repository.Merge([entry], testTransPairs);
		await repository.save();

		// キャッシュマネージャーで取得
		const manager = TermsCacheManager.getInstance();
		const terms = await manager.getTerms(testFilePath, testTransPairs);

		assert.strictEqual(terms.length, 1);
		assert.strictEqual(TermEntry.getTerm(terms[0], "ja"), "開発プロセス");
	});

	test("同じファイルの2回目の読み込みはキャッシュを使用する", async () => {
		// テストファイルを準備
		const repository = await TermsRepositoryCSV.create(testFilePath, testTransPairs);
		const entry = TermEntry.create("テスト", {
			ja: { term: "テスト", variants: [] },
			en: { term: "test", variants: [] },
		});
		await repository.Merge([entry], testTransPairs);
		await repository.save();

		const manager = TermsCacheManager.getInstance();

		// 1回目の読み込み
		const terms1 = await manager.getTerms(testFilePath, testTransPairs);
		assert.strictEqual(terms1.length, 1);

		// 2回目の読み込み（キャッシュ使用）
		const terms2 = await manager.getTerms(testFilePath, testTransPairs);
		assert.strictEqual(terms2.length, 1);

		// 同じインスタンスが返されることを確認
		assert.strictEqual(terms1, terms2);
	});

	test("ファイルが更新された場合はキャッシュを無効化して再読み込みする", async () => {
		// 初期ファイルを準備
		let repository = await TermsRepositoryCSV.create(testFilePath, testTransPairs);
		const entry1 = TermEntry.create("テスト1", {
			ja: { term: "テスト", variants: [] },
			en: { term: "test", variants: [] },
		});
		await repository.Merge([entry1], testTransPairs);
		await repository.save();

		const manager = TermsCacheManager.getInstance();

		// 1回目の読み込み
		const terms1 = await manager.getTerms(testFilePath, testTransPairs);
		assert.strictEqual(terms1.length, 1);

		// 少し待機してからファイルを更新
		await new Promise((resolve) => setTimeout(resolve, 100));

		// ファイルを更新
		repository = await TermsRepositoryCSV.load(testFilePath);
		const entry2 = TermEntry.create("テスト2", {
			ja: { term: "単体テスト", variants: [] },
			en: { term: "unit test", variants: [] },
		});
		await repository.Merge([entry2], testTransPairs);
		await repository.save();

		// 2回目の読み込み（キャッシュ無効化により再読み込み）
		const terms2 = await manager.getTerms(testFilePath, testTransPairs);
		assert.strictEqual(terms2.length, 2);

		// 異なるインスタンスが返されることを確認
		assert.notStrictEqual(terms1, terms2);
	});

	test("clearCacheで特定ファイルのキャッシュをクリアできる", async () => {
		// テストファイルを準備
		const repository = await TermsRepositoryCSV.create(testFilePath, testTransPairs);
		const entry = TermEntry.create("テスト", {
			ja: { term: "テスト", variants: [] },
			en: { term: "test", variants: [] },
		});
		await repository.Merge([entry], testTransPairs);
		await repository.save();

		const manager = TermsCacheManager.getInstance();

		// 1回目の読み込み（キャッシュ構築）
		const terms1 = await manager.getTerms(testFilePath, testTransPairs);
		assert.strictEqual(terms1.length, 1);

		// キャッシュクリア
		manager.clearCache(testFilePath);

		// 2回目の読み込み（キャッシュ再構築）
		const terms2 = await manager.getTerms(testFilePath, testTransPairs);
		assert.strictEqual(terms2.length, 1);

		// 異なるインスタンスが返されることを確認
		assert.notStrictEqual(terms1, terms2);
	});

	test("clearCache引数なしで全キャッシュをクリアできる", async () => {
		// テストファイルを準備
		const repository = await TermsRepositoryCSV.create(testFilePath, testTransPairs);
		const entry = TermEntry.create("テスト", {
			ja: { term: "テスト", variants: [] },
			en: { term: "test", variants: [] },
		});
		await repository.Merge([entry], testTransPairs);
		await repository.save();

		const manager = TermsCacheManager.getInstance();

		// 1回目の読み込み（キャッシュ構築）
		await manager.getTerms(testFilePath, testTransPairs);

		// 全キャッシュクリア
		manager.clearCache();

		// 2回目の読み込み（キャッシュ再構築）
		const terms2 = await manager.getTerms(testFilePath, testTransPairs);
		assert.strictEqual(terms2.length, 1);
	});
});
