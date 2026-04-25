import { strict as assert } from "node:assert";
import { getCodeBlockLineSet } from "../../../../core/markdown/code-block-lines";

suite("getCodeBlockLineSet", () => {
	test("フェンスドコードブロック内の行が含まれる（開閉行を含む）", () => {
		const md = ["before", "```ts", "const x = 1;", "console.log(x);", "```", "after"].join("\n");

		const lines = getCodeBlockLineSet(md);

		// fenceトークンのmapは [1, 5) — ```開始、内側2行、```終了
		assert.ok(lines.has(1), "```開始行が含まれる");
		assert.ok(lines.has(2), "コード本体1行目が含まれる");
		assert.ok(lines.has(3), "コード本体2行目が含まれる");
		assert.ok(lines.has(4), "```終了行が含まれる");
		assert.ok(!lines.has(0), "コードブロック外の行(before)は含まれない");
		assert.ok(!lines.has(5), "コードブロック外の行(after)は含まれない");
	});

	test("チルダフェンス（~~~）も対象になる", () => {
		const md = ["~~~", "code", "~~~"].join("\n");
		const lines = getCodeBlockLineSet(md);
		assert.ok(lines.has(0));
		assert.ok(lines.has(1));
		assert.ok(lines.has(2));
	});

	test("インデントコードブロック（4スペース）の行が含まれる", () => {
		const md = ["paragraph", "", "    indented code line 1", "    indented code line 2", "", "after"].join("\n");

		const lines = getCodeBlockLineSet(md);

		assert.ok(lines.has(2), "インデントコード1行目が含まれる");
		assert.ok(lines.has(3), "インデントコード2行目が含まれる");
		assert.ok(!lines.has(0), "通常段落は含まれない");
		assert.ok(!lines.has(5), "コードブロック後の行は含まれない");
	});

	test("インラインコード（バッククォート）の行は含まれない", () => {
		const md = "段落の中に `inline code` があります";
		const lines = getCodeBlockLineSet(md);

		assert.equal(lines.size, 0, "インラインコードはコードブロック扱いしない");
	});

	test("コードブロック内のmdaitマーカー風文字列が含まれる行も検出される", () => {
		const md = [
			"<!-- mdait abc need:translate -->",
			"# 見出し",
			"本文",
			"",
			"```",
			"<!-- mdait xyz need:translate -->",
			"```",
			"続きの本文",
		].join("\n");

		const lines = getCodeBlockLineSet(md);

		assert.ok(!lines.has(0), "外側のマーカー行は含まれない");
		assert.ok(lines.has(4), "```開始行が含まれる");
		assert.ok(lines.has(5), "コードブロック内のマーカー風行が含まれる");
		assert.ok(lines.has(6), "```終了行が含まれる");
		assert.ok(!lines.has(7), "コードブロック後の本文は含まれない");
	});

	test("コードブロックがない文書では空Setを返す", () => {
		const md = ["# 見出し", "", "本文だけの段落です。"].join("\n");
		const lines = getCodeBlockLineSet(md);
		assert.equal(lines.size, 0);
	});

	test("空文字列でも例外を投げず空Setを返す", () => {
		const lines = getCodeBlockLineSet("");
		assert.equal(lines.size, 0);
	});
});
