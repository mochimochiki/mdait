import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { embeddedMarkerProvider, externalMarkerProvider } from "../../../../core/markdown/marker-provider";
import { Configuration } from "../../../../infra/config/configuration";
import { resolveMarkerIO, resolveMarkerIOForFile } from "../../../../infra/config/marker-io";

declare let __vscodeMockWorkspaceRoot: string;

function createTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "mdait-mio-"));
}

/** markers.mode を含むコンフィグを customPath に書いて初期化する */
async function initWithMode(tempDir: string, mode?: string): Promise<Configuration> {
	const customDir = path.join(tempDir, ".mdait");
	fs.mkdirSync(customDir, { recursive: true });
	const customPath = path.join(customDir, "mdait.json");
	const obj: Record<string, unknown> = {
		transPairs: [{ sourceDir: "src/ja", targetDir: "src/en", sourceLang: "ja", targetLang: "en" }],
		primaryLang: "ja",
	};
	if (mode !== undefined) {
		obj.markers = { mode };
	}
	fs.writeFileSync(customPath, JSON.stringify(obj), "utf-8");
	const config = Configuration.getInstance();
	await config.initialize(customPath);
	return config;
}

suite("resolveMarkerIO", () => {
	let tempDir: string;

	setup(() => {
		Configuration.dispose();
		tempDir = createTempDir();
		__vscodeMockWorkspaceRoot = tempDir;
	});

	teardown(() => {
		Configuration.dispose();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("embedded では provider=embedded・ctx=undefined になること", async () => {
		const config = await initWithMode(tempDir, "embedded");
		const io = resolveMarkerIO(config, path.join(tempDir, "src/en/a.md"), "target");
		assert.strictEqual(io.provider, embeddedMarkerProvider);
		assert.strictEqual(io.ctx, undefined);
	});

	test("external では provider=external・ctx にワークスペース相対パスと role が入ること", async () => {
		const config = await initWithMode(tempDir, "external");
		const io = resolveMarkerIO(config, path.join(tempDir, "src/en/a.md"), "target");
		assert.strictEqual(io.provider, externalMarkerProvider);
		assert.deepStrictEqual(io.ctx, { filePath: "src/en/a.md", role: "target" });
	});

	test("external で role=source が ctx に反映されること", async () => {
		const config = await initWithMode(tempDir, "external");
		const io = resolveMarkerIO(config, path.join(tempDir, "src/ja/a.md"), "source");
		assert.strictEqual(io.ctx?.role, "source");
		assert.strictEqual(io.ctx?.filePath, "src/ja/a.md");
	});
});

suite("resolveMarkerIOForFile（role 自動判定）", () => {
	let tempDir: string;

	setup(() => {
		Configuration.dispose();
		tempDir = createTempDir();
		__vscodeMockWorkspaceRoot = tempDir;
	});

	teardown(() => {
		Configuration.dispose();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("external でソースディレクトリ配下のファイルは role=source と判定されること", async () => {
		const config = await initWithMode(tempDir, "external");
		const io = resolveMarkerIOForFile(config, path.join(tempDir, "src/ja/a.md"));
		assert.strictEqual(io.ctx?.role, "source");
		assert.strictEqual(io.ctx?.filePath, "src/ja/a.md");
	});

	test("external でターゲットディレクトリ配下のファイルは role=target と判定されること", async () => {
		const config = await initWithMode(tempDir, "external");
		const io = resolveMarkerIOForFile(config, path.join(tempDir, "src/en/a.md"));
		assert.strictEqual(io.ctx?.role, "target");
		assert.strictEqual(io.ctx?.filePath, "src/en/a.md");
	});

	test("embedded では ctx=undefined のまま provider=embedded になること", async () => {
		const config = await initWithMode(tempDir, "embedded");
		const io = resolveMarkerIOForFile(config, path.join(tempDir, "src/en/a.md"));
		assert.strictEqual(io.ctx, undefined);
	});
});
