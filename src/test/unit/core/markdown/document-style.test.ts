/**
 * 原稿の書式のくせ（改行コード・末尾改行）を測って復元する純関数のテスト。
 */

import * as assert from "node:assert";
import {
	DEFAULT_DOCUMENT_STYLE,
	applyDocumentStyle,
	detectDocumentStyle,
} from "../../../../core/markdown/document-style";

suite("原稿の書式のくせを測る（detectDocumentStyle）", () => {
	test("LF の原稿は LF と判定されること", () => {
		assert.deepStrictEqual(detectDocumentStyle("# 見出し\n\n本文。\n"), { eol: "\n", endsWithNewline: true });
	});

	test("CRLF の原稿は CRLF と判定されること", () => {
		assert.deepStrictEqual(detectDocumentStyle("# 見出し\r\n\r\n本文。\r\n"), {
			eol: "\r\n",
			endsWithNewline: true,
		});
	});

	test("混在した原稿は CRLF に倒すこと（LF に倒すと全行書き換えになる）", () => {
		assert.strictEqual(detectDocumentStyle("a\r\nb\nc\r\n").eol, "\r\n");
	});

	test("末尾に改行が無いことを覚えること", () => {
		assert.strictEqual(detectDocumentStyle("# 見出し\n\n本文。").endsWithNewline, false);
	});

	test("ファイルが無い・空のときは既定（LF・末尾改行あり）になること", () => {
		assert.deepStrictEqual(detectDocumentStyle(undefined), DEFAULT_DOCUMENT_STYLE);
		assert.deepStrictEqual(detectDocumentStyle(""), DEFAULT_DOCUMENT_STYLE);
	});
});

suite("測った書式へ揃える（applyDocumentStyle）", () => {
	const lf = "# 見出し\n\n本文。\n";

	test("CRLF の原稿には CRLF で書き出すこと", () => {
		assert.strictEqual(applyDocumentStyle(lf, { eol: "\r\n", endsWithNewline: true }), "# 見出し\r\n\r\n本文。\r\n");
	});

	test("LF の原稿はそのままであること", () => {
		assert.strictEqual(applyDocumentStyle(lf, { eol: "\n", endsWithNewline: true }), lf);
	});

	test("末尾改行の無い原稿には付けないこと", () => {
		assert.strictEqual(applyDocumentStyle(lf, { eol: "\n", endsWithNewline: false }), "# 見出し\n\n本文。");
	});

	test("末尾の改行が複数あっても、無しの原稿では全部落とすこと", () => {
		assert.strictEqual(applyDocumentStyle("a\n\n\n", { eol: "\n", endsWithNewline: false }), "a");
	});

	test("すでに CRLF が混ざった入力でも二重の \\r を作らないこと", () => {
		assert.strictEqual(applyDocumentStyle("a\r\nb\n", { eol: "\r\n", endsWithNewline: true }), "a\r\nb\r\n");
	});

	test("何度当てても結果が変わらないこと（冪等）", () => {
		const style = { eol: "\r\n", endsWithNewline: false } as const;
		const once = applyDocumentStyle(lf, style);
		assert.strictEqual(applyDocumentStyle(once, style), once);
	});
});
