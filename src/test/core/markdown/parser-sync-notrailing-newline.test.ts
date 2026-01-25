// テストガイドラインに従いテスト実装します。
// 問題再現テスト: 末尾に空白行がない状態でのsync時のマーカー分裂問題
//
// 根本原因: markdown-itは空行で段落を区切る。マーカーの直前に空行がないと、
// マーカーが前のテキストと同じinlineトークンに含まれてしまい、境界として正しく検出されない。
// 解決策: パース前処理としてmdaitマーカーの直前に空行がなければ空行を挿入する正規化処理を追加。

import { strict as assert } from "node:assert";
import { markdownParser } from "../../../core/markdown/parser";

const testConfig = { sync: { level: 2 } } as unknown as import("../../../config/configuration").Configuration;

suite("MarkdownParser（末尾空行なしのsync問題）", () => {
	test("末尾に空白行がない状態でマーカー前に空行がない場合でも正しくパースされること", () => {
		// ユーザーが報告した問題ケース:
		// Head2の最後にfugaを追記し、末尾に空白行がない状態
		const md = `---
title: "日本語テスト2"
mdait:
  front: 31412bb9
---
<!-- mdait 19b4e27e -->
# Head1

<!-- mdait 23a70283 -->
# Head2

hoge

fuga
<!-- mdait 780de6f0 -->
## Head3
`;

		const parsed = markdownParser.parse(md, testConfig);

		// 期待値: 3ユニット (Head1, Head2, Head3)
		assert.strictEqual(parsed.units.length, 3, "3ユニットになるべき");
		assert.strictEqual(parsed.units[0].marker.hash, "19b4e27e", "Head1のハッシュ");
		assert.strictEqual(parsed.units[1].marker.hash, "23a70283", "Head2のハッシュ");
		assert.strictEqual(parsed.units[2].marker.hash, "780de6f0", "Head3のハッシュ");

		// Head2のcontentにfugaが含まれるべき（正規化により正しく属する）
		assert.ok(parsed.units[1].content.includes("fuga"), "Head2にfugaが含まれるべき");

		// Head3のcontentにfugaが含まれてはいけない
		assert.ok(!parsed.units[2].content.includes("fuga"), "Head3にfugaは含まれるべきでない");
	});

	test("空白行がある正常ケースのパース確認", () => {
		const md = `---
title: "日本語テスト2"
mdait:
  front: 31412bb9
---
<!-- mdait 19b4e27e -->
# Head1

<!-- mdait 23a70283 -->
# Head2

hoge

fuga

<!-- mdait 780de6f0 -->
## Head3
`;

		const parsed = markdownParser.parse(md, testConfig);

		// 期待値: 3ユニット (Head1, Head2, Head3)
		assert.strictEqual(parsed.units.length, 3, "3ユニットになるべき");
		assert.ok(parsed.units[1].content.includes("fuga"), "Head2にfugaが含まれるべき");
	});

	test("sync後stringify後の再parse時にマーカーが分裂しないこと", () => {
		const md = `---
title: "日本語テスト2"
mdait:
  front: 31412bb9
---
<!-- mdait 19b4e27e -->
# Head1

<!-- mdait 23a70283 -->
# Head2

hoge

fuga
<!-- mdait 780de6f0 -->
## Head3
`;

		// 1回目のparse
		const parsed1 = markdownParser.parse(md, testConfig);

		// stringify
		const stringified1 = markdownParser.stringify(parsed1);

		// 2回目のparse
		const parsed2 = markdownParser.parse(stringified1, testConfig);

		// ユニット数が変わっていないこと
		assert.strictEqual(parsed2.units.length, parsed1.units.length, "stringify→parse後もユニット数が同じであるべき");

		// 各ユニットのハッシュが対応していること
		for (let i = 0; i < parsed1.units.length; i++) {
			assert.strictEqual(
				parsed2.units[i].marker.hash,
				parsed1.units[i].marker.hash,
				`ユニット${i}のハッシュが一致するべき`,
			);
		}
	});

	test("複数連続するマーカーの間に空行がなくても正しくパースされること", () => {
		const md = `<!-- mdait abc123 -->
# Heading 1

Content 1.
<!-- mdait def456 -->
# Heading 2

Content 2.
`;

		const parsed = markdownParser.parse(md, testConfig);

		// 2ユニットになるべき
		assert.strictEqual(parsed.units.length, 2, "2ユニットになるべき");
		assert.strictEqual(parsed.units[0].marker.hash, "abc123");
		assert.strictEqual(parsed.units[1].marker.hash, "def456");

		// Content 1がHeading 1に属すること
		assert.ok(parsed.units[0].content.includes("Content 1"), "Content 1がHeading 1に含まれるべき");

		// Content 2がHeading 2に属すること
		assert.ok(parsed.units[1].content.includes("Content 2"), "Content 2がHeading 2に含まれるべき");
	});
});
