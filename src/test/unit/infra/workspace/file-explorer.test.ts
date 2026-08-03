import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Configuration } from "../../../../infra/config/configuration";
import { FileExplorer } from "../../../../infra/workspace/file-explorer";
import { toWorkspaceRelativePath } from "../../../../infra/workspace/workspace-path";

declare let __vscodeMockWorkspaceRoot: string;

/**
 * FileExplorer.normalizePath の回帰テスト。
 *
 * configBaseDir は Configuration.getInstance().getConfigBaseDir() から導出される。
 * customConfigPath を持たない素の Configuration では getConfigBaseDir() が
 * workspaceFolders[0].uri.fsPath（= __vscodeMockWorkspaceRoot）と一致するため、
 * setup で Configuration をリセットしモックのワークスペースルートを既知値に固定する。
 */
suite("FileExplorer.normalizePath", () => {
	setup(() => {
		// 他テストが customConfigPath を設定済みの可能性があるため確実にリセットし、
		// configBaseDir がモックのワークスペースルートと一致する状態にする。
		Configuration.dispose();
		__vscodeMockWorkspaceRoot = "/mock-workspace";
	});

	teardown(() => {
		Configuration.dispose();
		__vscodeMockWorkspaceRoot = "/mock-workspace";
	});

	test("ベース配下の絶対パスはベース相対パスに変換される", () => {
		__vscodeMockWorkspaceRoot = "/ws";
		const explorer = new FileExplorer();

		assert.strictEqual(
			explorer.normalizePath("/ws/content/en/x.md"),
			"content/en/x.md",
		);
	});

	test("兄弟ディレクトリのプレフィックス誤一致を起こさず絶対パスのまま返す", () => {
		// base が /ws/ja のとき /ws/ja-backup/a.md は配下外。
		// 旧 startsWith 実装では ja-backup を誤って配下扱いしていた回帰。
		__vscodeMockWorkspaceRoot = "/ws/ja";
		const explorer = new FileExplorer();

		assert.strictEqual(
			explorer.normalizePath("/ws/ja-backup/a.md"),
			"/ws/ja-backup/a.md",
		);
	});

	test("相対パス入力はそのまま返す（絶対パスでないため即 return）", () => {
		__vscodeMockWorkspaceRoot = "/ws";
		const explorer = new FileExplorer();

		assert.strictEqual(explorer.normalizePath("content/en"), "content/en");
	});

	test("バックスラッシュ区切りはスラッシュに正規化される", () => {
		__vscodeMockWorkspaceRoot = "/ws";
		const explorer = new FileExplorer();

		assert.strictEqual(
			explorer.normalizePath("content\\en\\x.md"),
			"content/en/x.md",
		);
	});

	// path.relative はプラットフォーム依存。ドライブレターの大小無視は Windows のみ。
	if (process.platform === "win32") {
		test("ドライブレターの大小差を吸収してベース相対パスに変換される（Windows限定）", () => {
			__vscodeMockWorkspaceRoot = "c:/ws";
			const explorer = new FileExplorer();

			assert.strictEqual(explorer.normalizePath("C:/ws/ja/x.md"), "ja/x.md");
		});
	}
});

/**
 * `unit-state` の行のキーは `toWorkspaceRelativePath`（ワークスペースルート基準）で作られる。
 * `FileExplorer.normalizePath` は設定ファイルの置き場所（configBaseDir）基準なので、
 * カスタム config パスを使うと両者は別の文字列になる。
 *
 * sync の孤立判定で両方を混ぜていたため、非MDファイルの行が毎 sync 全滅していた
 * （docs/design/unit-state.md §5-(4)）。二度と混ぜないよう、食い違うこと自体をここで固定する。
 */
suite("unit-state のキー基準（normalizePath と toWorkspaceRelativePath の違い）", () => {
	let tempDir: string;

	setup(async () => {
		Configuration.dispose();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-keybase-"));
		fs.mkdirSync(path.join(tempDir, "site", ".mdait"), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, "site", ".mdait", "mdait.json"),
			JSON.stringify({
				transPairs: [{ sourceLang: "ja", sourceDir: "content/ja", targetLang: "en", targetDir: "content/en" }],
			}),
			"utf-8",
		);
		__vscodeMockWorkspaceRoot = tempDir;
		await Configuration.getInstance().initialize(path.join(tempDir, "site", ".mdait", "mdait.json"));
	});

	teardown(() => {
		Configuration.dispose();
		__vscodeMockWorkspaceRoot = "/mock-workspace";
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("カスタム config パスでは2つの正規化が別の文字列になること", () => {
		const explorer = new FileExplorer();
		const abs = path.join(tempDir, "site", "content", "en", "readme.txt");

		assert.strictEqual(explorer.normalizePath(abs), "content/en/readme.txt");
		assert.strictEqual(toWorkspaceRelativePath(abs), "site/content/en/readme.txt");
	});
});
