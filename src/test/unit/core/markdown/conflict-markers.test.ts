import * as assert from "node:assert";
import { hasConflictMarkers } from "../../../../core/markdown/conflict-markers";

suite("hasConflictMarkers（合流の途中の原稿の見分け）", () => {
	test("ふつうの原稿は合流の途中ではないこと", () => {
		assert.strictEqual(hasConflictMarkers("# 見出し\n\n本文です。\n"), false);
	});

	test("見出しの下線（=====）を競合マーカーと取り違えないこと", () => {
		assert.strictEqual(hasConflictMarkers("見出し\n=====\n\n本文\n"), false);
	});

	test("区切り線（-------）や引用（>）を取り違えないこと", () => {
		assert.strictEqual(hasConflictMarkers("-------\n\n> 引用\n>> 入れ子の引用\n"), false);
	});

	test("競合マーカーが残っていれば合流の途中と判定すること", () => {
		const content = ["# 見出し", "<<<<<<< HEAD", "こちらの本文", "=======", "あちらの本文", ">>>>>>> other", ""].join(
			"\n",
		);
		assert.strictEqual(hasConflictMarkers(content), true);
	});

	test("SVN が残す形（名札が .mine / .r42）でも判定すること", () => {
		const content = ["<<<<<<< .mine", "こちら", "=======", "あちら", ">>>>>>> .r42", ""].join("\n");
		assert.strictEqual(hasConflictMarkers(content), true);
	});

	test("片側だけ消しかけた原稿も合流の途中と見なすこと", () => {
		assert.strictEqual(hasConflictMarkers("本文\n=======\nもう片方\n"), true);
	});

	test("コードブロックの中の実例は数えないこと（マーカーの書き方を解説する原稿）", () => {
		const content = [
			"# 競合の直し方",
			"",
			"```",
			"<<<<<<< HEAD",
			"こちらの本文",
			"=======",
			"あちらの本文",
			">>>>>>> other",
			"```",
			"",
			"上の形が出たら直します。",
			"",
		].join("\n");
		assert.strictEqual(hasConflictMarkers(content), false);
	});

	test("CRLF の原稿でも判定すること", () => {
		assert.strictEqual(hasConflictMarkers("# 見出し\r\n<<<<<<< HEAD\r\n本文\r\n"), true);
	});
});
