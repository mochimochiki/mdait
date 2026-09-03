import * as assert from "node:assert";
import * as path from "node:path";
import { buildArgTransformer } from "../../../../infra/debug/debug-command-handler";

/**
 * デバッグ IPC の引数の組み直し。
 *
 * ここが崩れると**静かに壊れる**。相対パスを渡したとき、実 Extension Host では
 * `RelativePattern` も `Uri.file` も解決できず、対象0件のまま `done` で返る
 * （実測: `mdait.translate.directory content/en/child/child2` が `totalFiles: 0`）。
 * 呼び手からは「やることが無かった」と区別が付かないので、テストで固定する。
 */
suite("デバッグIPCの引数の組み直し", () => {
	const root = path.join(path.sep, "ws");

	test("フォルダ指定のコマンドは、相対パスをワークスペース基準の絶対パスへ直す", () => {
		const transform = buildArgTransformer("mdait.translate.directory", root);
		assert.ok(transform, "変換が要るコマンドである");
		const [item] = transform(["content/en/child"]) as [
			{ type: string; directoryPath: string; label: string },
		];
		assert.strictEqual(item.type, "directory");
		assert.strictEqual(item.directoryPath, path.join(root, "content/en/child"));
		assert.strictEqual(item.label, "child");
	});

	test("ファイル指定のコマンドも、相対パスを絶対パスへ直す", () => {
		const transform = buildArgTransformer("mdait.translate.file", root);
		assert.ok(transform);
		const [item] = transform(["content/en/10_test.md"]) as [
			{ type: string; filePath: string; fileName: string },
		];
		assert.strictEqual(item.type, "file");
		assert.strictEqual(item.filePath, path.join(root, "content/en/10_test.md"));
		assert.strictEqual(item.fileName, "10_test.md");
	});

	test("Uri を受け取るコマンドも、相対パスを絶対パスへ直してから Uri にする", () => {
		const transform = buildArgTransformer("mdait.trans", root);
		assert.ok(transform);
		const [uri] = transform(["content/en/10_test.md"]) as [{ fsPath: string }];
		assert.strictEqual(uri.fsPath, path.join(root, "content/en/10_test.md"));
	});

	test("絶対パスはそのまま通す（二重に連結しない）", () => {
		const absolute = path.join(root, "content", "en", "child");
		const transform = buildArgTransformer("mdait.translate.directory", root);
		assert.ok(transform);
		const [item] = transform([absolute]) as [{ directoryPath: string }];
		assert.strictEqual(item.directoryPath, absolute);
	});

	test("パス以外の引数（文字列でないもの）には手を出さない", () => {
		const transform = buildArgTransformer("mdait.translate.directory", root);
		assert.ok(transform);
		const original = { type: "directory", directoryPath: "/already/an/item" };
		const [item] = transform([original]) as [typeof original];
		assert.strictEqual(item, original);
	});

	test("組み直しの要らないコマンドには変換を返さない", () => {
		assert.strictEqual(buildArgTransformer("mdait.sync", root), undefined);
	});
});
