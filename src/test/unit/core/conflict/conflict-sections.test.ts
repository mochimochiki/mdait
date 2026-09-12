/**
 * 競合ファイルから両側と共通の祖先を切り出す係のテスト（roadmap-v04 P02）。
 *
 * ここが持つ約束は「**それぞれの陣営から見た完全なファイル**を返すこと」である。
 * ブロックの中の行だけを返すと、CSV の引用符の中の改行や XML の入れ子を、この係が
 * 知らないまま切り刻むことになる。完全なファイルなら本物のパーサーに通せる。
 */

import { strict as assert } from "node:assert";
import { splitConflictedFile } from "../../../../core/conflict/conflict-sections";

suite("競合ファイルの切り出し", () => {
	test("競合が無ければ、両側とも元のままで conflicted は false", () => {
		const found = splitConflictedFile("a\nb\nc\n");

		assert.equal(found.conflicted, false);
		assert.equal(found.ours, "a\nb\nc\n");
		assert.equal(found.theirs, "a\nb\nc\n");
		assert.equal(found.sections.length, 0);
	});

	test("競合の外側の行は、両側に同じように残る", () => {
		const found = splitConflictedFile("前\n<<<<<<< HEAD\n私\n=======\n相手\n>>>>>>> theirs\n後\n");

		assert.equal(found.ours, "前\n私\n後\n");
		assert.equal(found.theirs, "前\n相手\n後\n");
	});

	test("ブロックが複数あっても、それぞれの側を通して組み立てる", () => {
		const content = [
			"a",
			"<<<<<<< HEAD",
			"私1",
			"=======",
			"相手1",
			">>>>>>> theirs",
			"b",
			"<<<<<<< HEAD",
			"私2",
			"=======",
			"相手2",
			">>>>>>> theirs",
			"c",
			"",
		].join("\n");
		const found = splitConflictedFile(content);

		assert.equal(found.ours, "a\n私1\nb\n私2\nc\n");
		assert.equal(found.theirs, "a\n相手1\nb\n相手2\nc\n");
		assert.equal(found.sections.length, 2);
	});

	test("diff3 形式なら共通の祖先も取れる", () => {
		const content = [
			"<<<<<<< HEAD",
			"私",
			"||||||| base",
			"もと",
			"=======",
			"相手",
			">>>>>>> theirs",
			"",
		].join("\n");
		const found = splitConflictedFile(content);

		assert.equal(found.base, "もと\n");
		assert.deepEqual(found.sections[0].base, ["もと"]);
	});

	test("祖先を持たないブロックが1つでもあれば、祖先の全文は組み立てない", () => {
		// 混ぜて組み立てると「どの版でもない別物」になる。材料が1つ減るだけで先へ進む
		const content = [
			"<<<<<<< HEAD",
			"私1",
			"||||||| base",
			"もと",
			"=======",
			"相手1",
			">>>>>>> theirs",
			"<<<<<<< HEAD",
			"私2",
			"=======",
			"相手2",
			">>>>>>> theirs",
			"",
		].join("\n");
		const found = splitConflictedFile(content);

		assert.equal(found.base, undefined);
		assert.equal(found.sections.length, 2);
	});

	test("片方が空のブロック（片方だけが足した）も切り出せる", () => {
		const found = splitConflictedFile("a\n<<<<<<< HEAD\n=======\n足した\n>>>>>>> theirs\n");

		assert.equal(found.ours, "a\n");
		assert.equal(found.theirs, "a\n足した\n");
	});

	test("閉じていないブロックも、そこまで読めた分を採る", () => {
		// 手で直しかけて途中でやめたファイル。例外を投げると解決の道が塞がる
		const found = splitConflictedFile("a\n<<<<<<< HEAD\n私\n=======\n相手\n");

		assert.equal(found.conflicted, true);
		assert.equal(found.ours, "a\n私\n");
		assert.equal(found.theirs, "a\n相手\n");
	});

	test("CRLF のファイルは CRLF のまま返す", () => {
		const found = splitConflictedFile("a\r\n<<<<<<< HEAD\r\n私\r\n=======\r\n相手\r\n>>>>>>> theirs\r\n");

		assert.equal(found.ours, "a\r\n私\r\n");
		assert.doesNotMatch(found.ours, /[^\r]\n/);
	});

	test("末尾に改行が無いファイルは、無いまま返す", () => {
		const found = splitConflictedFile("a\n<<<<<<< HEAD\n私\n=======\n相手\n>>>>>>> theirs");

		assert.equal(found.ours, "a\n私");
	});

	test("見出しの下線や引用をマーカーと取り違えない", () => {
		// `=====`（6文字以下）は見出しの下線、`>>>` は引用の入れ子
		const content = "見出し\n=====\n\n>>> 引用\n-------\n";
		const found = splitConflictedFile(content);

		assert.equal(found.conflicted, false);
		assert.equal(found.ours, content);
	});

	test("名札の無いマーカーでも読める", () => {
		const found = splitConflictedFile("<<<<<<<\n私\n=======\n相手\n>>>>>>>\n");

		assert.equal(found.ours, "私\n");
		assert.equal(found.theirs, "相手\n");
	});

	test("ブロックの位置を行番号で持つ", () => {
		const found = splitConflictedFile("a\nb\n<<<<<<< HEAD\n私\n=======\n相手\n>>>>>>> theirs\nc\n");

		assert.equal(found.sections[0].startLine, 2);
		assert.equal(found.sections[0].endLine, 6);
	});
});
