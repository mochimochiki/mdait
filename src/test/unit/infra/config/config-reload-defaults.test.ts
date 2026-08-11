// mdait.json からキーを消したとき、設定が既定へ戻るかのテスト。
//
// 設定UIの「リセット」はキーをファイルから削除する（settings-panel.ts の applyReset）。
// 読み込み側が「書いてあるキーだけ上書き」だと、画面は既定値を表示するのに engine は
// 古い値で動き続ける — 画面と挙動が食い違ったまま、再起動するまで気づけない。

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Configuration } from "../../../../infra/config/configuration";

declare let __vscodeMockWorkspaceRoot: string;

function createTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "mdait-cfg-"));
}

const BASE = {
	transPairs: [{ sourceDir: "src/ja", targetDir: "src/en", sourceLang: "ja", targetLang: "en" }],
	primaryLang: "ja",
};

suite("設定の再読み込みで、消したキーが既定へ戻る", () => {
	let tempDir: string;
	let customPath: string;

	setup(() => {
		Configuration.dispose();
		tempDir = createTempDir();
		__vscodeMockWorkspaceRoot = tempDir;
		const customDir = path.join(tempDir, ".mdait");
		fs.mkdirSync(customDir, { recursive: true });
		customPath = path.join(customDir, "mdait.json");
	});

	teardown(() => {
		Configuration.dispose();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	/** 設定を書いて読み直す（ファイル監視ではなく initialize 経由で確実に読ませる） */
	async function reload(extra: Record<string, unknown>): Promise<Configuration> {
		fs.writeFileSync(customPath, JSON.stringify({ ...BASE, ...extra }), "utf-8");
		Configuration.dispose();
		const config = Configuration.getInstance();
		await config.initialize(customPath);
		return config;
	}

	/** 同じインスタンスのまま読み直す（設定UIのリセット・外部編集と同じ経路） */
	async function reloadSameInstance(config: Configuration, extra: Record<string, unknown>): Promise<void> {
		fs.writeFileSync(customPath, JSON.stringify({ ...BASE, ...extra }), "utf-8");
		await config.initialize(customPath);
	}

	test("trans.extensions を消すと .md だけに戻ること", async () => {
		const config = await reload({ trans: { extensions: [".txt"] } });
		assert.deepStrictEqual(config.trans.extensions, [".txt"], "前提: .txt が効いている");

		await reloadSameInstance(config, {});

		assert.strictEqual(
			config.trans.extensions,
			undefined,
			"キーを消したら既定（.md のみ）へ戻る。戻らないと、管理から外したはずの .txt を訳し続ける",
		);
	});

	test("markers.mode を消すと embedded に戻ること", async () => {
		const config = await reload({ markers: { mode: "external" } });
		assert.strictEqual(config.isExternalMarkers(), true, "前提: external が効いている");

		await reloadSameInstance(config, {});

		assert.strictEqual(config.markers.mode, "embedded", "マーカーの保管方式が既定へ戻る");
	});

	test("sync.autoDelete を消すと既定（true）へ戻ること", async () => {
		const config = await reload({ sync: { autoDelete: false } });
		assert.strictEqual(config.sync.autoDelete, false, "前提: false が効いている");

		await reloadSameInstance(config, {});

		assert.strictEqual(config.sync.autoDelete, true);
	});

	test("ignoredPatterns を消すと既定へ戻ること", async () => {
		const config = await reload({ ignoredPatterns: ["**/draft/**"] });
		assert.strictEqual(config.ignoredPatterns, "**/draft/**", "前提: 指定が効いている");

		await reloadSameInstance(config, {});

		assert.strictEqual(config.ignoredPatterns, "**/node_modules/**");
	});

	test("壊れた JSON では既定へ戻さず、直前の設定を保つこと", async () => {
		// 編集の途中でファイルが一時的に壊れることは普通に起きる。
		// そこで既定へ倒すと、保存のたびに設定が飛んだように見える
		const config = await reload({ markers: { mode: "external" } });
		fs.writeFileSync(customPath, "{ broken", "utf-8");

		await assert.rejects(() => config.initialize(customPath));

		assert.strictEqual(config.markers.mode, "external", "壊れている間は直前の設定のまま");
	});
});
