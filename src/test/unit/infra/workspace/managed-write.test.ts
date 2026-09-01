/**
 * 管理下 Markdown の書き出し口（writeManagedMarkdown）のテスト。
 *
 * ここが持つ約束は3つ。原稿の書式へ揃えること、出来上がりが同じなら書かないこと、
 * そして**読めないファイルを「無い」と同じに扱わないこと**（中身を確かめられないまま
 * 上書きすると、改行のくせごと人の原稿を壊す）。
 */

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeManagedMarkdown, writeManagedMarkdownSync } from "../../../../infra/workspace/managed-write";

suite("管理下 Markdown の書き出し口", () => {
	let tempDir: string;

	setup(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-managed-write-"));
	});

	teardown(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("新しいファイルは既定の書式（LF・末尾改行）で作られること", async () => {
		const file = path.join(tempDir, "new.md");

		const written = await writeManagedMarkdown(file, "# 見出し\n\n本文。\n");

		assert.strictEqual(written, true, "書いたことを返すこと");
		assert.strictEqual(fs.readFileSync(file, "utf-8"), "# 見出し\n\n本文。\n");
	});

	test("CRLF の原稿には CRLF で書き出すこと", async () => {
		const file = path.join(tempDir, "crlf.md");
		fs.writeFileSync(file, "# 見出し\r\n\r\n古い本文。\r\n", "utf-8");

		await writeManagedMarkdown(file, "# 見出し\n\n新しい本文。\n");

		assert.strictEqual(fs.readFileSync(file, "utf-8"), "# 見出し\r\n\r\n新しい本文。\r\n");
	});

	test("出来上がりが同じなら書かず、書かなかったことを返すこと", async () => {
		const file = path.join(tempDir, "same.md");
		fs.writeFileSync(file, "# 見出し\r\n\r\n本文。\r\n", "utf-8");
		const stamp = fs.statSync(file).mtimeMs;
		await new Promise((resolve) => setTimeout(resolve, 10));

		// 改行コードだけが違う内容を渡す。揃え直すと元と同じになる
		const written = await writeManagedMarkdown(file, "# 見出し\n\n本文。\n");

		assert.strictEqual(written, false);
		assert.strictEqual(fs.statSync(file).mtimeMs, stamp, "ファイルに触れていないこと");
	});

	test("読めないファイルを新規扱いで上書きしないこと（例外はそのまま返す）", () => {
		// ディレクトリを指す＝読めるはずのファイルが読めない状況。ENOENT ではない
		const notAFile = path.join(tempDir, "dir");
		fs.mkdirSync(notAFile);

		assert.throws(() => writeManagedMarkdownSync(notAFile, "# 見出し\n"), /EISDIR|EPERM|EACCES/);
	});

	test("同期版も同じ約束を守ること", () => {
		const file = path.join(tempDir, "sync.md");
		fs.writeFileSync(file, "# 見出し\r\n\r\n本文。", "utf-8"); // 末尾改行なし・CRLF

		const written = writeManagedMarkdownSync(file, "# 見出し\n\n変えた本文。\n");

		assert.strictEqual(written, true);
		assert.strictEqual(fs.readFileSync(file, "utf-8"), "# 見出し\r\n\r\n変えた本文。");
	});
});
