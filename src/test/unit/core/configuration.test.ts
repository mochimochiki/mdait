import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Configuration } from "../../../infra/config/configuration";
import {
	embeddedMarkerProvider,
	externalMarkerProvider,
} from "../../../core/markdown/marker-provider";

declare let __vscodeMockWorkspaceRoot: string;

/** テスト用一時ディレクトリを作成 */
function createTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "mdait-cfg-"));
}

/** テスト用一時ディレクトリを削除 */
function cleanupTempDir(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

/** 最小限の有効なコンフィグを文字列で返す */
function minimalConfig(primaryLang = "en"): string {
	return JSON.stringify({
		transPairs: [
			{
				sourceDir: "src/ja",
				targetDir: "src/en",
				sourceLang: "ja",
				targetLang: "en",
			},
		],
		primaryLang,
	});
}

suite("Configuration", () => {
	let tempDir: string;

	setup(() => {
		Configuration.dispose();
		tempDir = createTempDir();
		__vscodeMockWorkspaceRoot = tempDir;
	});

	teardown(() => {
		Configuration.dispose();
		cleanupTempDir(tempDir);
	});

	test("カスタムパスが未設定の場合はワークスペースルートの .mdait/mdait.json を返すこと", () => {
		const config = Configuration.getInstance();
		const expected = path.join(tempDir, ".mdait", "mdait.json");
		assert.strictEqual(config.getConfigFilePath(), expected);
	});

	test("initialize(customPath) でカスタムパスが設定されること", async () => {
		const customDir = path.join(tempDir, "subproject", ".mdait");
		fs.mkdirSync(customDir, { recursive: true });
		const customPath = path.join(customDir, "mdait.json");
		fs.writeFileSync(customPath, minimalConfig(), "utf-8");

		const config = Configuration.getInstance();
		await config.initialize(customPath);

		assert.strictEqual(config.getConfigFilePath(), customPath);
	});

	test("initialize(customPath) でカスタムパスのコンフィグが読み込まれること", async () => {
		const customDir = path.join(tempDir, "subproject", ".mdait");
		fs.mkdirSync(customDir, { recursive: true });
		const customPath = path.join(customDir, "mdait.json");
		fs.writeFileSync(customPath, minimalConfig("ja"), "utf-8");

		const config = Configuration.getInstance();
		await config.initialize(customPath);

		assert.strictEqual(config.primaryLang, "ja");
		assert.strictEqual(config.transPairs.length, 1);
	});

	test("initialize() 後に initialize(customPath) を呼ぶとカスタムパスに切り替わること", async () => {
		// デフォルトパスに設定を作成
		const defaultDir = path.join(tempDir, ".mdait");
		fs.mkdirSync(defaultDir, { recursive: true });
		fs.writeFileSync(
			path.join(defaultDir, "mdait.json"),
			minimalConfig("en"),
			"utf-8",
		);

		// カスタムパスに設定を作成
		const customDir = path.join(tempDir, "sub", ".mdait");
		fs.mkdirSync(customDir, { recursive: true });
		const customPath = path.join(customDir, "mdait.json");
		fs.writeFileSync(customPath, minimalConfig("ko"), "utf-8");

		const config = Configuration.getInstance();
		await config.initialize(); // デフォルトパスで初期化
		assert.strictEqual(config.primaryLang, "en");

		await config.initialize(customPath); // カスタムパスで再初期化
		assert.strictEqual(config.getConfigFilePath(), customPath);
		assert.strictEqual(config.primaryLang, "ko");
	});

	test("initialize(customPath) が失敗した場合に customConfigPath が元の値にロールバックされること", async () => {
		// デフォルトパスに設定を作成
		const defaultDir = path.join(tempDir, ".mdait");
		fs.mkdirSync(defaultDir, { recursive: true });
		fs.writeFileSync(
			path.join(defaultDir, "mdait.json"),
			minimalConfig("en"),
			"utf-8",
		);

		const config = Configuration.getInstance();
		await config.initialize(); // デフォルトパスで初期化（customConfigPath は undefined）

		// 存在しないパスで initialize() → 失敗
		const nonExistentPath = path.join(tempDir, "nonexistent", "mdait.json");
		await assert.rejects(() => config.initialize(nonExistentPath));

		// customConfigPath が undefined（デフォルト）のまま維持されること
		const expectedDefaultPath = path.join(tempDir, ".mdait", "mdait.json");
		assert.strictEqual(config.getConfigFilePath(), expectedDefaultPath);
	});

	test("getConfigBaseDir() はカスタムパスなしの場合ワークスペースルートを返すこと", () => {
		const config = Configuration.getInstance();
		const expected = tempDir; // workspaceRoot
		assert.strictEqual(config.getConfigBaseDir(), expected);
	});

	test("getConfigBaseDir() はカスタムパスの .mdait の親ディレクトリを返すこと", async () => {
		const subDir = path.join(tempDir, "subproject");
		const customDir = path.join(subDir, ".mdait");
		fs.mkdirSync(customDir, { recursive: true });
		const customPath = path.join(customDir, "mdait.json");
		fs.writeFileSync(customPath, minimalConfig(), "utf-8");

		const config = Configuration.getInstance();
		await config.initialize(customPath);

		// /tempDir/subproject/.mdait/mdait.json → /tempDir/subproject
		assert.strictEqual(config.getConfigBaseDir(), subDir);
	});

	/** markers.mode を含むコンフィグを customPath に書いて初期化する */
	async function initWithMarkerMode(mode?: string): Promise<Configuration> {
		const customDir = path.join(tempDir, ".mdait");
		fs.mkdirSync(customDir, { recursive: true });
		const customPath = path.join(customDir, "mdait.json");
		const obj: Record<string, unknown> = JSON.parse(minimalConfig());
		if (mode !== undefined) {
			obj.markers = { mode };
		}
		fs.writeFileSync(customPath, JSON.stringify(obj), "utf-8");
		const config = Configuration.getInstance();
		await config.initialize(customPath);
		return config;
	}

	test("markers.mode 未指定の場合は既定で embedded になること", async () => {
		const config = await initWithMarkerMode(undefined);
		assert.strictEqual(config.markers.mode, "embedded");
		assert.strictEqual(config.isExternalMarkers(), false);
		assert.strictEqual(config.getMarkerProvider(), embeddedMarkerProvider);
	});

	test("markers.mode が external の場合に external Provider を返すこと", async () => {
		const config = await initWithMarkerMode("external");
		assert.strictEqual(config.markers.mode, "external");
		assert.strictEqual(config.isExternalMarkers(), true);
		assert.strictEqual(config.getMarkerProvider(), externalMarkerProvider);
	});

	test("markers.mode が不正値の場合は embedded のままになること", async () => {
		const config = await initWithMarkerMode("invalid");
		assert.strictEqual(config.markers.mode, "embedded");
		assert.strictEqual(config.getMarkerProvider(), embeddedMarkerProvider);
	});
});
