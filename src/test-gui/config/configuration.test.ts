// Configuration テスト
// テストガイドラインに従いテスト実装します。

import { strict as assert } from "node:assert";
import * as vscode from "vscode";
import { Configuration, type TransPair } from "../../config/configuration";

suite("Configuration", () => {
	let config: Configuration;

	setup(() => {
		config = new Configuration();
	});

	suite("getTransPairForFile", () => {
		test("ターゲットディレクトリのファイルに対応する翻訳ペアを取得できる", () => {
			config.transPairs = [
				{
					sourceDir: "content/ja",
					targetDir: "content/en",
					sourceLang: "ja",
					targetLang: "en",
				},
			];

			const result = config.getTransPairForTargetFile("workspace/content/en/10_test.md");
			assert.notEqual(result, null);
			assert.equal(result?.targetDir, "content/en");
			assert.equal(result?.targetLang, "en");
		});

		test("対応しないファイルパスの場合nullを返す", () => {
			config.transPairs = [
				{
					sourceDir: "content/ja",
					targetDir: "content/en",
					sourceLang: "ja",
					targetLang: "en",
				},
			];

			const result = config.getTransPairForTargetFile("workspace/other/10_test.md");
			assert.equal(result, null);
		});

		test("翻訳ペアが空の場合nullを返す", () => {
			config.transPairs = [];

			const result = config.getTransPairForTargetFile("workspace/content/ja/10_test.md");
			assert.equal(result, null);
		});
	});
});
