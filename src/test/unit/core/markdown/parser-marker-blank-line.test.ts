import { strict as assert } from "node:assert";
import { markdownParser } from "../../../../core/markdown/parser";
import type { Configuration } from "../../../../infra/config/configuration";

function makeConfig(level: number): Configuration {
	return { sync: { level } } as unknown as Configuration;
}

const NORMAL = `<!-- mdait aaaa1111 -->
# タイトル

本文A

<!-- mdait bbbb2222 -->
## 章1

本文B
`;

/** Prettier や markdownlint がマーカーの直後へ空行を入れた形 */
const FORMATTED = `<!-- mdait aaaa1111 -->

# タイトル

本文A

<!-- mdait bbbb2222 -->

## 章1

本文B
`;

/**
 * マーカーと見出しのあいだの空行を読み飛ばすこと（embedded 固有の緩和）。
 *
 * 空行を挟むと統合しない読み方だと、そのマーカーは「見出しを伴わない単独の境界」になり、
 * **章の数だけ空の幽霊ユニットが生えて、続く見出しは自分のマーカーを失う**。整形ツールを
 * かけただけで起きる（docs/design/merge-resilience.md）。
 */
suite("MarkdownParser: マーカーと見出しのあいだの空行", () => {
	const config = makeConfig(2);

	test("空行が入っていても、ユニットの数も中身も正規形と変わらない", () => {
		const normal = markdownParser.parse(NORMAL, config);
		const formatted = markdownParser.parse(FORMATTED, config);

		assert.equal(formatted.units.length, normal.units.length, "幽霊ユニットが生えている");
		assert.deepEqual(
			formatted.units.map((unit) => unit.content),
			normal.units.map((unit) => unit.content),
		);
	});

	test("空行が入っていても、見出しは自分のマーカーを保つ", () => {
		const parsed = markdownParser.parse(FORMATTED, config);
		assert.deepEqual(
			parsed.units.map((unit) => unit.marker.hash),
			["aaaa1111", "bbbb2222"],
		);
	});

	test("書き出すと正規形（空行なし）へ戻る", () => {
		const formatted = markdownParser.parse(FORMATTED, config);
		assert.equal(markdownParser.stringify(formatted), markdownParser.stringify(markdownParser.parse(NORMAL, config)));
	});

	test("空行が2つ以上でも同じように読む", () => {
		const doubled = FORMATTED.replace(/-->\n\n/g, "-->\n\n\n");
		const parsed = markdownParser.parse(doubled, config);
		assert.equal(parsed.units.length, 2);
		assert.deepEqual(
			parsed.units.map((unit) => unit.marker.hash),
			["aaaa1111", "bbbb2222"],
		);
	});

	test("空行のあとが見出しでなければ統合しない（単独のマーカーは単独のまま）", () => {
		const standalone = `<!-- mdait aaaa1111 -->

前書きの本文

## 章1

本文B
`;
		const parsed = markdownParser.parse(standalone, config);
		assert.equal(parsed.units.length, 2);
		assert.equal(parsed.units[0].marker.hash, "aaaa1111");
		assert.ok(parsed.units[0].content.startsWith("前書きの本文"), "本文が見出しに吸われている");
		assert.equal(parsed.units[1].title, "章1");
	});
});
