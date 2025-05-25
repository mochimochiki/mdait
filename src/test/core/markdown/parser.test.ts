import { strict as assert } from "node:assert";
import { markdownParser } from "../../../core/markdown/parser";

suite("MarkdownItParser: 基本ユニット分割", () => {
	test("単純な見出し2つ", () => {
		const md = `
# タイトル1

本文1

# タイトル2
本文2`;
		const doc = markdownParser.parse(md);
		const units = doc.units;
		assert.equal(units.length, 2);
		assert.equal(units[0].title, "タイトル1");
		assert.equal(units[1].title, "タイトル2");
		assert.ok(units[0].content.includes("タイトル1"));
		assert.ok(units[1].content.includes("タイトル2"));
	});
	test("mdaitコメント付き", () => {
		const md = `<!-- mdait abcd1234 from:efgh5678 need:translate -->
# 見出し
本文`;
		const doc = markdownParser.parse(md);
		const units = doc.units;
		assert.equal(units.length, 1);
		assert.equal(units[0].marker.hash, "abcd1234");
		assert.equal(units[0].marker.from, "efgh5678");
		assert.equal(units[0].marker.need, "translate");
	});

	test("本文にリストやコードブロック", () => {
		const md = `
# h1

- item1
- item2

\`\`\`
code
block
\`\`\``;
		const doc = markdownParser.parse(md);
		const units = doc.units;
		assert.equal(units.length, 1);
		assert.ok(units[0].content.includes("- item1"));
		assert.ok(units[0].content.includes("```"));
	});

	test("ファイル先頭・末尾の見出し", () => {
		const md = `# first
body

# last
end`;
		const doc = markdownParser.parse(md);
		const units = doc.units;
		assert.equal(units.length, 2);
		assert.equal(units[0].title, "first");
		assert.equal(units[1].title, "last");
	});

	test("コードブロック内の#やmdaitコメントは無視", () => {
		const md = `
# h1
\`\`\`
# not heading
<!-- mdait fake -->
\`\`\`
text`;
		const doc = markdownParser.parse(md);
		const units = doc.units;
		assert.equal(units.length, 1);
		assert.ok(units[0].content.includes("# not heading"));
		assert.ok(units[0].content.includes("<!-- mdait fake -->"));
	});

	test("コードブロック内のコメントと見出しは無視される", () => {
		const codeBlock = [
			"```",
			"# コード内見出し",
			"<!-- mdait fakehash from:fakesrc need:ignore -->",
			"コード本文",
			"```",
		].join("\n");
		const md = `# 外部見出し\n\n${codeBlock}\nテキスト`;
		const doc = markdownParser.parse(md);
		const units = doc.units;
		assert.equal(units.length, 1);
		assert.equal(units[0].title, "外部見出し");
		assert.ok(units[0].content.includes("# コード内見出し"));
		assert.ok(
			units[0].content.includes(
				"<!-- mdait fakehash from:fakesrc need:ignore -->",
			),
		);
	});
	test("parse→stringifyでロスレス", () => {
		const md = `
<!-- mdait abcd1234 from:efgh5678 need:translate -->
# 見出し
本文
- list
`;
		const doc = markdownParser.parse(md);
		const md2 = markdownParser.stringify(doc);
		// 空白や改行の差異は許容
		assert.ok(md2.replace(/\s+/g, "") === md.replace(/\s+/g, ""));
	});
	test("8文字未満のmdaitコメントは無視される", () => {
		const md = "<!-- mdait abcd from:efgh need:translate -->\n# 見出し\n本文";
		const doc = markdownParser.parse(md);
		const units = doc.units;
		// mdaitHeaderはnullまたは空のhashになる（パース不可）
		assert.equal(units.length, 1);
		assert.ok(
			!units[0].marker ||
				!units[0].marker.hash ||
				units[0].marker.hash.length !== 8,
		);
	});
	test("複数行のmdaitコメント", () => {
		const md = `
<!-- mdait abcd1234
from:efgh5678
need:translate -->
# 見出し

本文`;
		const doc = markdownParser.parse(md);
		const units = doc.units;
		assert.equal(units.length, 1);
		assert.equal(units[0].marker.hash, "abcd1234");
		assert.equal(units[0].marker.from, "efgh5678");
		assert.equal(units[0].marker.need, "translate");
	});

	test("複数レベルにわたるmdaitコメント付き見出し", () => {
		const md = `
<!-- mdait hash1234 from:src45678 need:tag1 -->
# 見出し1

本文1

<!-- mdait hash2345 from:src56789 need:tag2 -->
## 見出し2

本文2`;
		const doc = markdownParser.parse(md);
		const units = doc.units;
		assert.equal(units.length, 2);
		assert.equal(units[0].title, "見出し1");
		assert.equal(units[0].marker.hash, "hash1234");
		assert.equal(units[0].marker.from, "src45678");
		assert.equal(units[0].marker.need, "tag1");
		assert.equal(units[1].title, "見出し2");
		assert.equal(units[1].marker.hash, "hash2345");
		assert.equal(units[1].marker.from, "src56789");
		assert.equal(units[1].marker.need, "tag2");
	});

	test("TOMLフロントマターにmdaitコメントはつかない", () => {
		const tomlFrontMatter = [
			"---",
			"title: 'テスト'",
			"lang: 'ja'",
			"---",
		].join("\n");
		const md = `${tomlFrontMatter}\n\n# 見出し\n本文`;
		const doc = markdownParser.parse(md);
		const units = doc.units;
		assert.equal(units.length, 1);
		assert.equal(units[0].title, "見出し");
		assert.ok(doc.frontMatterRaw?.includes("---"));
		assert.ok(doc.frontMatterRaw?.includes("title: 'テスト'"));
	});
	test("複数のmdaitコメント", () => {
		const md = [
			"<!-- mdait hashAAAA from:srcAAAAA need:tagA -->",
			"",
			"# 見出しA",
			"本文A",
			"",
			"<!-- mdait hashBBBB from:srcBBBBB need:tagB -->",
			"# 見出しB",
			"本文B",
		].join("\n");
		const doc = markdownParser.parse(md);
		const units = doc.units;
		assert.equal(units.length, 2);
		assert.equal(units[0].marker.hash, "hashAAAA");
		// 直前のmdaitのみ有効
		assert.equal(units[1].marker.hash, "hashBBBB");
	});
	test("複数行のmdaitコメントと複数見出し", () => {
		const md = [
			"<!-- mdait hashMMMM",
			"from:srcMMMM1",
			"need:tagM -->",
			"# 見出しM",
			"本文M",
			"",
			"# 見出しN",
			"本文N",
		].join("\n");
		const doc = markdownParser.parse(md);
		const units = doc.units;
		assert.equal(units.length, 2);
		assert.equal(units[0].marker.hash, "hashMMMM");
		assert.equal(units[0].marker.from, "srcMMMM1");
		assert.equal(units[0].marker.need, "tagM");
		assert.ok(!units[1].marker.hash);
	});

	test("フロントマター直後のmdaitコメントと見出し", () => {
		const md = [
			"---",
			"title: 'フロントマター'",
			"---",
			"<!-- mdait hashFFF1 from:srcFFFF1 need:tagF -->",
			"# 見出しF",
			"本文F",
		].join("\n");
		const doc = markdownParser.parse(md);
		const units = doc.units;
		assert.equal(units.length, 1);
		assert.equal(units[0].marker.hash, "hashFFF1");
		assert.equal(units[0].title, "見出しF");
		assert.ok(doc.frontMatterRaw?.includes("title: 'フロントマター'"));
	});

	test("YAMLフロントマター＋複数見出し＋mdaitコメントの組み合わせ", () => {
		const md = [
			"---",
			"title: '多見出しテスト'",
			"lang: 'ja'",
			"---",
			"",
			"<!-- mdait hashA123 from:srcA123 need:tagA -->",
			"# 見出しA",
			"本文A",
			"",
			"# 見出しB",
			"本文B",
			"",
			"<!-- mdait hashB234 from:srcB234 need:tagB -->",
			"# 見出しC",
			"本文C",
		].join("\n");
		const doc = markdownParser.parse(md);
		const units = doc.units;
		assert.equal(units.length, 3);
		assert.ok(doc.frontMatterRaw?.includes("title: '多見出しテスト'"));
		assert.equal(units[0].title, "見出しA");
		assert.equal(units[0].marker.hash, "hashA123");
		assert.equal(units[1].title, "見出しB");
		assert.ok(!units[1].marker.hash);
		assert.equal(units[2].title, "見出しC");
		assert.equal(units[2].marker.hash, "hashB234");
	});
});
