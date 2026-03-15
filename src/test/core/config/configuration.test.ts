import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { Configuration } from "../../../config/configuration";

suite("Configuration primaryLang設定のテスト", () => {
	let workspaceRoot: string;
	let configPath: string;
	let backupContent: string | undefined;

	function writeConfig(config: unknown): void {
		fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
	}

	setup(() => {
		const folders = vscode.workspace.workspaceFolders;
		if (!folders || folders.length === 0) {
			throw new Error("ワークスペースが開かれていません");
		}

		workspaceRoot = folders[0].uri.fsPath;
		configPath = path.join(workspaceRoot, "mdait.json");
		backupContent = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : undefined;
		Configuration.dispose();
	});

	teardown(() => {
		Configuration.dispose();
		if (backupContent === undefined) {
			if (fs.existsSync(configPath)) {
				fs.unlinkSync(configPath);
			}
			return;
		}

		fs.writeFileSync(configPath, backupContent, "utf8");
	});

	test("トップ階層primaryLangを読み込める", async () => {
		writeConfig({
			transPairs: [
				{
					sourceLang: "ja",
					sourceDir: "docs/ja",
					targetLang: "en",
					targetDir: "docs/en",
				},
			],
			primaryLang: "en",
			terms: {
				filename: "terms.yaml",
			},
		});

		const configuration = await Configuration.getInstance().initialize();

		assert.equal(configuration.getTermsPrimaryLang(), "en");
		assert.equal(configuration.getTermsFileFormat(), "yaml");
		assert.equal(configuration.validate(), null);
		assert.equal(configuration.isConfigured(), true);
	});

	test("primaryLang未設定はvalidation errorになる", async () => {
		writeConfig({
			transPairs: [
				{
					sourceLang: "ja",
					sourceDir: "docs/ja",
					targetLang: "en",
					targetDir: "docs/en",
				},
			],
			terms: {
				filename: "terms.csv",
			},
		});

		const configuration = await Configuration.getInstance().initialize();

		assert.equal(configuration.getTermsPrimaryLang(), "");
		assert.equal(configuration.validate(), "Primary language (primaryLang) is not configured.");
		assert.equal(configuration.isConfigured(), false);
	});

	test("tm.retryLimit は trans.retryLimit と独立して読み込める", async () => {
		writeConfig({
			transPairs: [
				{
					sourceLang: "ja",
					sourceDir: "docs/ja",
					targetLang: "en",
					targetDir: "docs/en",
				},
			],
			primaryLang: "en",
			trans: {
				retryLimit: 4,
			},
			tm: {
				retryLimit: 2,
			},
		});

		const configuration = await Configuration.getInstance().initialize();

		assert.equal(configuration.trans.retryLimit, 4);
		assert.equal(configuration.getTmRetryLimit(), 2);
	});
});
