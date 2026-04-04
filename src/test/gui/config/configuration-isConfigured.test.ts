import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Configuration } from "../../../infra/config/configuration";

function createTempConfigFile(): string {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-config-test-"));
	const mdaitDir = path.join(tempDir, ".mdait");
	fs.mkdirSync(mdaitDir, { recursive: true });
	const configPath = path.join(mdaitDir, "mdait.json");
	fs.writeFileSync(configPath, "{}", "utf-8");
	return configPath;
}

suite("Configuration", () => {
	teardown(() => {
		Configuration.dispose();
	});

	test("primaryLang が未設定の構成は isConfigured で未設定扱いになる", () => {
		const configPath = createTempConfigFile();
		const config = Configuration.getInstance();
		config.transPairs = [
			{
				sourceDir: "docs/ja",
				targetDir: "docs/en",
				sourceLang: "ja",
				targetLang: "en",
			},
		];
		config.primaryLang = "";
		config.getConfigFilePath = () => configPath;

		assert.strictEqual(config.isConfigured(), false);

		fs.rmSync(path.dirname(path.dirname(configPath)), { recursive: true, force: true });
	});

	test("primaryLang を含む構成は isConfigured で設定済み扱いになる", () => {
		const configPath = createTempConfigFile();
		const config = Configuration.getInstance();
		config.transPairs = [
			{
				sourceDir: "docs/ja",
				targetDir: "docs/en",
				sourceLang: "ja",
				targetLang: "en",
			},
			{
				sourceDir: "docs/en",
				targetDir: "docs/zh-hans",
				sourceLang: "en",
				targetLang: "zh-hans",
			},
		];
		config.primaryLang = "en";
		config.getConfigFilePath = () => configPath;

		assert.strictEqual(config.isConfigured(), true);

		fs.rmSync(path.dirname(path.dirname(configPath)), { recursive: true, force: true });
	});
});
