// getUnitPosition のユニットテスト
// コードブロック内のマーカーを境界として選択しないことを確認する

import { strict as assert } from "node:assert";
import { getUnitPosition } from "../../../../commands/trans/trans-command";

suite("getUnitPosition", () => {
	test("通常の2ユニット構成で正しい範囲を返すこと", () => {
		const text = [
			"<!-- mdait aaaa1111 from:aaaa1111 need:translate -->",
			"# 見出し1",
			"",
			"本文コンテンツ",
			"",
			"<!-- mdait bbbb2222 from:bbbb2222 -->",
			"# 見出し2",
			"",
			"次のユニット",
		].join("\n");

		const markerText = "<!-- mdait aaaa1111 from:aaaa1111 need:translate -->";
		const result = getUnitPosition(text, markerText);

		assert.ok(result !== null, "結果がnullでないこと");
		assert.strictEqual(result.start, 0);
		// end は次のマーカー "<!-- mdait bbbb2222 ..." の開始位置
		const nextMarkerPos = text.indexOf("<!-- mdait bbbb2222");
		assert.strictEqual(result.end, nextMarkerPos);
	});

	test("次のマーカーが存在しない場合、end がテキスト末尾を指すこと", () => {
		const text = [
			"<!-- mdait aaaa1111 from:aaaa1111 need:translate -->",
			"# 見出し1",
			"",
			"本文コンテンツ（次のマーカーなし）",
		].join("\n");

		const markerText = "<!-- mdait aaaa1111 from:aaaa1111 need:translate -->";
		const result = getUnitPosition(text, markerText);

		assert.ok(result !== null, "結果がnullでないこと");
		assert.strictEqual(result.end, text.length, "endがテキスト末尾であること");
	});

	test("markerText が存在しない場合、null を返すこと", () => {
		const text = "<!-- mdait aaaa1111 -->\n本文";
		const result = getUnitPosition(text, "<!-- mdait notexist -->");
		assert.strictEqual(result, null);
	});

	test("コードブロック内のマーカーを次の境界として選択しないこと", () => {
		// このシナリオが今回の修正の核心
		// ユニット内のコードブロックにサンプルマーカーが含まれている場合、
		// コードブロック外の次のマーカーを境界として選択する
		const text = [
			"<!-- mdait aaaa1111 from:aaaa1111 need:translate -->",
			"# コードフェンス付きユニット",
			"",
			"以下はコードの例:",
			"",
			"```markdown",
			"<!-- mdait a1b2c3d4 need:translate -->",
			"# サンプル見出し",
			"```",
			"",
			"上記がコード例です。",
			"",
			"<!-- mdait cccc3333 from:cccc3333 -->",
			"# 次の実際のユニット",
			"",
			"次のユニットの内容",
		].join("\n");

		const markerText = "<!-- mdait aaaa1111 from:aaaa1111 need:translate -->";
		const result = getUnitPosition(text, markerText);

		assert.ok(result !== null, "結果がnullでないこと");
		// コードブロック内の "<!-- mdait a1b2c3d4 ..." ではなく、
		// コードブロック外の "<!-- mdait cccc3333 ..." が境界になること
		const codeBlockMarkerPos = text.indexOf("<!-- mdait a1b2c3d4");
		const realNextMarkerPos = text.indexOf("<!-- mdait cccc3333");
		assert.ok(
			result.end !== codeBlockMarkerPos,
			"コードブロック内のマーカーを境界にしていないこと",
		);
		assert.strictEqual(
			result.end,
			realNextMarkerPos,
			"コードブロック外の次のマーカーを境界に選択していること",
		);
	});

	test("コードブロックのみにマーカーがある場合、end がテキスト末尾を指すこと", () => {
		const text = [
			"<!-- mdait aaaa1111 from:aaaa1111 need:translate -->",
			"# ユニット",
			"",
			"```markdown",
			"<!-- mdait a1b2c3d4 need:translate -->",
			"サンプル",
			"```",
			"",
			"コードブロック内以外にマーカーはない",
		].join("\n");

		const markerText = "<!-- mdait aaaa1111 from:aaaa1111 need:translate -->";
		const result = getUnitPosition(text, markerText);

		assert.ok(result !== null, "結果がnullでないこと");
		assert.strictEqual(
			result.end,
			text.length,
			"コードブロック内マーカーをスキップしてファイル末尾を返すこと",
		);
	});
});
