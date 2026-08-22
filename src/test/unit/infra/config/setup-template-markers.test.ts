// 新規セットアップのテンプレートと、markers キーを持たない既存ワークスペースの据え置きを固定するテスト。
//
// mdait.json は setup コマンドが assets/mdait.template.json をそのまま書き出して作る。
// 新規は external（原文を1バイトも書き換えない）にしたい。一方で Configuration の既定は
// embedded のままでなければならない — 既定を倒すと、markers キーを持たない既存ワークスペースが
// 一斉に external になり、本文に埋まっているマーカーがただのコメント文字列として扱われる。
// 「テンプレートは external」「キーが無ければ embedded」の2つが揃って初めて据え置きが成り立つ。

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Configuration } from "../../../../infra/config/configuration";

declare let __vscodeMockWorkspaceRoot: string;

/** リポジトリルート（out/test/unit/infra/config から5階層上） */
const repoRoot = path.resolve(__dirname, "..", "..", "..", "..", "..");
const templatePath = path.join(repoRoot, "assets", "mdait.template.json");

/** テンプレートを読む（setup コマンドが書き出すのと同じ内容） */
function loadTemplate(): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(templatePath, "utf-8"));
}

suite("新規セットアップの既定（テンプレート）とキー未指定の据え置き", () => {
	let tempDir: string;
	let customPath: string;

	setup(() => {
		Configuration.dispose();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-tpl-"));
		__vscodeMockWorkspaceRoot = tempDir;
		const customDir = path.join(tempDir, ".mdait");
		fs.mkdirSync(customDir, { recursive: true });
		customPath = path.join(customDir, "mdait.json");
	});

	teardown(() => {
		Configuration.dispose();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	/** obj を mdait.json として書き、Configuration を初期化する */
	async function initWith(obj: unknown): Promise<Configuration> {
		fs.writeFileSync(customPath, JSON.stringify(obj), "utf-8");
		const config = Configuration.getInstance();
		await config.initialize(customPath);
		return config;
	}

	test("テンプレートに markers.mode: external が書かれていること", () => {
		const template = loadTemplate();
		assert.deepStrictEqual(
			template.markers,
			{ mode: "external" },
			"新規セットアップの mdait.json は external で始まる（原文を書き換えない）",
		);
	});

	test("テンプレートそのままの mdait.json を読むと external になること", async () => {
		const config = await initWith(loadTemplate());
		assert.strictEqual(config.markers.mode, "external");
		assert.strictEqual(config.isExternalMarkers(), true);
	});

	test("markers キーを持たない mdait.json は embedded のままであること（既存ワークスペースの据え置き）", async () => {
		const withoutMarkers = loadTemplate();
		// JSON.stringify は undefined のキーを書き出さない = markers キーの無い mdait.json
		withoutMarkers.markers = undefined;

		const config = await initWith(withoutMarkers);

		assert.strictEqual(
			config.markers.mode,
			"embedded",
			"Configuration の既定を external へ倒してはいけない。倒すと既存ワークスペースの本文マーカーが、ただのコメント文字列として無視される",
		);
		assert.strictEqual(config.isExternalMarkers(), false);
	});
});
