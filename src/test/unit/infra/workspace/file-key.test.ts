import * as assert from "node:assert";
import { normalizeFileKey } from "../../../../infra/workspace/file-key";

suite("normalizeFileKey", () => {
	test("冗長セグメントは解決される", () => {
		assert.strictEqual(normalizeFileKey("/ws/docs/../docs/a.md", "linux"), "/ws/docs/a.md");
	});

	test("linuxでは大文字小文字を保持する", () => {
		assert.strictEqual(normalizeFileKey("/WS/A.md", "linux"), "/WS/A.md");
	});

	test("win32では大文字小文字を無視して同一キーになる", () => {
		// ドライブレターやパス表記の大小差で同一ファイルが別キー扱いに
		// ならないことを確認する（FileMutexの排他とダーティ検出の前提）
		assert.strictEqual(normalizeFileKey("/WS/Docs/A.md", "win32"), normalizeFileKey("/ws/docs/a.md", "win32"));
	});
});
