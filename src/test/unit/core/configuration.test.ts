import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Configuration } from "../../../infra/config/configuration";
import { Logger } from "../../../infra/logging/logger";
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

	/** trans.extensions を含むコンフィグを customPath に書いて初期化する */
	async function initWithExtensions(
		extensions: unknown,
	): Promise<Configuration> {
		const customDir = path.join(tempDir, ".mdait");
		fs.mkdirSync(customDir, { recursive: true });
		const customPath = path.join(customDir, "mdait.json");
		const obj: Record<string, unknown> = JSON.parse(minimalConfig());
		obj.trans = { extensions };
		fs.writeFileSync(customPath, JSON.stringify(obj), "utf-8");
		const config = Configuration.getInstance();
		await config.initialize(customPath);
		return config;
	}

	test("trans.extensions のドット無し指定に先頭ドットが補完されること", async () => {
		const config = await initWithExtensions(["txt", "csv"]);
		assert.deepStrictEqual(config.trans.extensions, [".txt", ".csv"]);
	});

	test("trans.extensions のドット有り指定はそのまま（小文字化のみ）維持されること", async () => {
		const config = await initWithExtensions([".TXT", ".Csv"]);
		assert.deepStrictEqual(config.trans.extensions, [".txt", ".csv"]);
	});

	test("trans.extensions の空文字・非文字列要素が除外されること", async () => {
		const config = await initWithExtensions(["txt", "", "  ", 123, null]);
		assert.deepStrictEqual(config.trans.extensions, [".txt"]);
	});

	test("trans.extensions の '.' のみ・空要素は壊れた glob を防ぐため除外されること", async () => {
		// "." は buildExtensionGlob で e.slice(1)→"" となり `**/*.{md,}` を生むため弾く
		const config = await initWithExtensions([".", " . ", "txt"]);
		assert.deepStrictEqual(config.trans.extensions, [".txt"]);
	});
});

suite("Configuration orphanTargetPolicy", () => {
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

	async function initWithSync(sync: Record<string, unknown> | undefined): Promise<Configuration> {
		const customDir = path.join(tempDir, ".mdait");
		fs.mkdirSync(customDir, { recursive: true });
		const customPath = path.join(customDir, "mdait.json");
		const obj: Record<string, unknown> = JSON.parse(minimalConfig());
		if (sync !== undefined) {
			obj.sync = sync;
		}
		fs.writeFileSync(customPath, JSON.stringify(obj), "utf-8");
		const config = Configuration.getInstance();
		await config.initialize(customPath);
		return config;
	}

	test("未指定の場合は autoDelete:true 既定から delete に解決されること", async () => {
		const config = await initWithSync(undefined);
		assert.strictEqual(config.getOrphanTargetPolicy(), "delete");
	});

	test("autoDelete:false は verify に後方互換マッピングされること", async () => {
		const config = await initWithSync({ autoDelete: false });
		assert.strictEqual(config.getOrphanTargetPolicy(), "verify");
	});

	test("orphanTargetPolicy:verify が読み込まれること", async () => {
		const config = await initWithSync({ orphanTargetPolicy: "verify" });
		assert.strictEqual(config.getOrphanTargetPolicy(), "verify");
	});

	test("orphanTargetPolicy:delete が読み込まれること", async () => {
		const config = await initWithSync({ autoDelete: false, orphanTargetPolicy: "delete" });
		assert.strictEqual(config.getOrphanTargetPolicy(), "delete");
	});

	test("autoDelete と orphanTargetPolicy の両方指定時は orphanTargetPolicy が優先されること", async () => {
		const config = await initWithSync({ autoDelete: true, orphanTargetPolicy: "verify" });
		assert.strictEqual(config.getOrphanTargetPolicy(), "verify");
	});

	test("不正な orphanTargetPolicy 値は無視され autoDelete から解決されること", async () => {
		const config = await initWithSync({ autoDelete: false, orphanTargetPolicy: "invalid" });
		assert.strictEqual(config.getOrphanTargetPolicy(), "verify");
	});

	test("レガシー値 keep は警告の上 verify として解釈されること", async () => {
		const logger = Logger.getInstance();
		const warnings: string[] = [];
		const listener = logger.addLogListener((_line, entry) => {
			if (entry.level === "WARN" && entry.scope === "config") {
				warnings.push(entry.message);
			}
		});
		try {
			const config = await initWithSync({ autoDelete: true, orphanTargetPolicy: "keep" });
			assert.strictEqual(config.getOrphanTargetPolicy(), "verify");
			assert.ok(
				warnings.some((m) => m.includes("keep")),
				"警告ログが出力されること",
			);
		} finally {
			listener.dispose();
		}
	});

	test("レガシー値 backfill は警告の上 verify として解釈されること", async () => {
		const logger = Logger.getInstance();
		const warnings: string[] = [];
		const listener = logger.addLogListener((_line, entry) => {
			if (entry.level === "WARN" && entry.scope === "config") {
				warnings.push(entry.message);
			}
		});
		try {
			const config = await initWithSync({ autoDelete: true, orphanTargetPolicy: "backfill" });
			assert.strictEqual(config.getOrphanTargetPolicy(), "verify");
			assert.ok(
				warnings.some((m) => m.includes("backfill")),
				"警告ログが出力されること",
			);
		} finally {
			listener.dispose();
		}
	});
});

suite("Configuration aiReview", () => {
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

	async function initWithAiReview(review: Record<string, unknown> | undefined): Promise<Configuration> {
		const customDir = path.join(tempDir, ".mdait");
		fs.mkdirSync(customDir, { recursive: true });
		const customPath = path.join(customDir, "mdait.json");
		const obj: Record<string, unknown> = JSON.parse(minimalConfig());
		if (review !== undefined) {
			obj.aiReview = review;
		}
		fs.writeFileSync(customPath, JSON.stringify(obj), "utf-8");
		const config = Configuration.getInstance();
		await config.initialize(customPath);
		return config;
	}

	test("未指定の場合はデフォルト値（autoApprove:true, batchSize:3）になること", async () => {
		const config = await initWithAiReview(undefined);
		assert.strictEqual(config.aiReview.autoApprove, true);
		assert.strictEqual(config.aiReview.batchSize, 3);
	});

	test("有効な値が読み込まれ、範囲外はクランプされること", async () => {
		const config = await initWithAiReview({
			autoApprove: false,
			batchSize: 99,
		});
		assert.strictEqual(config.aiReview.autoApprove, false);
		assert.strictEqual(config.aiReview.batchSize, 10);
	});

	test("batchSize は 1 未満が 1 にクランプされ、小数は切り捨てられること", async () => {
		const floorConfig = await initWithAiReview({ batchSize: 2.9 });
		assert.strictEqual(floorConfig.aiReview.batchSize, 2);
		Configuration.dispose();
		const minConfig = await initWithAiReview({ batchSize: 0 });
		assert.strictEqual(minConfig.aiReview.batchSize, 1);
	});

	test("batchSize が数値以外の場合は無視されデフォルトが維持されること", async () => {
		const config = await initWithAiReview({ batchSize: "big" });
		assert.strictEqual(config.aiReview.batchSize, 3);
	});

	test("autoApprove が boolean 以外（文字列）の場合は無視されデフォルトが維持されること", async () => {
		const config = await initWithAiReview({ autoApprove: "yes" });
		assert.strictEqual(config.aiReview.autoApprove, true);
	});
});

suite("Configuration trans.maxUnitsPerRun", () => {
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

	async function initWithTrans(trans: Record<string, unknown> | undefined): Promise<Configuration> {
		const customDir = path.join(tempDir, ".mdait");
		fs.mkdirSync(customDir, { recursive: true });
		const customPath = path.join(customDir, "mdait.json");
		const obj: Record<string, unknown> = JSON.parse(minimalConfig());
		if (trans !== undefined) {
			obj.trans = trans;
		}
		fs.writeFileSync(customPath, JSON.stringify(obj), "utf-8");
		const config = Configuration.getInstance();
		await config.initialize(customPath);
		return config;
	}

	test("未指定の場合はデフォルト値 300 になること", async () => {
		const config = await initWithTrans(undefined);
		assert.strictEqual(config.trans.maxUnitsPerRun, 300);
	});

	test("有効な正値が読み込まれ、小数は切り捨てられること", async () => {
		const config = await initWithTrans({ maxUnitsPerRun: 500.9 });
		assert.strictEqual(config.trans.maxUnitsPerRun, 500);
	});

	test("0 以下は上限なし（0）に正規化されること", async () => {
		const zeroConfig = await initWithTrans({ maxUnitsPerRun: 0 });
		assert.strictEqual(zeroConfig.trans.maxUnitsPerRun, 0);
		Configuration.dispose();
		const negativeConfig = await initWithTrans({ maxUnitsPerRun: -10 });
		assert.strictEqual(negativeConfig.trans.maxUnitsPerRun, 0);
	});

	test("数値以外の場合は無視されデフォルトが維持されること", async () => {
		const config = await initWithTrans({ maxUnitsPerRun: "many" });
		assert.strictEqual(config.trans.maxUnitsPerRun, 300);
	});
});
