import * as assert from "node:assert";
import { Configuration } from "../../../../infra/config/configuration";
import { FileExplorer } from "../../../../infra/workspace/file-explorer";

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
