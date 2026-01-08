import { strict as assert } from "node:assert";
import { markdownParser } from "../../../core/markdown/parser";
import type { Configuration } from "../../../config/configuration";

const testConfig = {
	sync: { autoMarkerLevel: 2 },
} as unknown as Configuration;

suite("MarkdownParser（autoMarkerLevel連続見出し最適化）", () => {
	test("連続見出し: H1直後にH2がある場合、H1のみマーカー付与", () => {
		const md = `# タイトル
## サブタイトル

本文内容`;

		const parsed = markdownParser.parse(md, testConfig);

		// H1のみユニットとして分割される
		assert.strictEqual(parsed.units.length, 1);
		assert.ok(parsed.units[0].content.includes("# タイトル"));
		assert.ok(parsed.units[0].content.includes("## サブタイトル"));
		assert.ok(parsed.units[0].content.includes("本文内容"));
	});

	test("独立見出し: H2間に本文がある場合、両方にマーカー付与", () => {
		const md = `## セクション1

本文1

## セクション2

本文2`;

		const parsed = markdownParser.parse(md, testConfig);

		// 2つのユニットに分割
		assert.strictEqual(parsed.units.length, 2);
		assert.ok(parsed.units[0].content.includes("セクション1"));
		assert.ok(parsed.units[1].content.includes("セクション2"));
	});

	test("3段階連続: H1→H2→H3の連続では、H1のみマーカー付与", () => {
		const md = `# メインタイトル
## サブタイトル
### 詳細タイトル

本文開始`;

		const parsed = markdownParser.parse(md, testConfig);

		// H1のみユニットとして認識
		assert.strictEqual(parsed.units.length, 1);
		assert.ok(parsed.units[0].content.includes("メインタイトル"));
		assert.ok(parsed.units[0].content.includes("サブタイトル"));
		assert.ok(parsed.units[0].content.includes("詳細タイトル"));
	});

	test("混在パターン: 連続と独立が混在する場合", () => {
		const md = `# H1
## H2直後

本文A

## H2独立

本文B`;

		const parsed = markdownParser.parse(md, testConfig);

		// H1（H2含む）と独立H2の2ユニット
		assert.strictEqual(parsed.units.length, 2);
	});

	test("autoMarkerLevel=1: H1のみが境界として扱われる", () => {
		const md = `# H1-1

本文1

## H2

本文2

# H1-2

本文3`;

		const config = {
			sync: { autoMarkerLevel: 1 },
		} as unknown as Configuration;

		const parsed = markdownParser.parse(md, config);

		// H1のみが境界なので2ユニット（H2は境界にならない）
		assert.strictEqual(parsed.units.length, 2);
		assert.ok(parsed.units[0].content.includes("H1-1"));
		assert.ok(parsed.units[0].content.includes("H2")); // H2は最初のH1ユニットに含まれる
		assert.ok(parsed.units[1].content.includes("H1-2"));
	});

	test("連続見出しでレベルが逆転する場合: より上位のものを選択", () => {
		const md = `## H2
# H1

本文`;

		const parsed = markdownParser.parse(md, testConfig);

		// H1の方が上位なのでH1のみがユニット境界
		assert.strictEqual(parsed.units.length, 1);
		assert.ok(parsed.units[0].content.includes("H2"));
		assert.ok(parsed.units[0].content.includes("H1"));
	});

	test("既存マーカーがある場合: マーカー付き見出しは尊重される", () => {
		const md = `<!-- mdait abc123 -->
# H1
## H2

本文`;

		const parsed = markdownParser.parse(md, testConfig);

		// 既存マーカーがあるので1ユニット
		assert.strictEqual(parsed.units.length, 1);
		assert.strictEqual(parsed.units[0].marker.hash, "abc123");
		assert.ok(parsed.units[0].content.includes("# H1"));
		assert.ok(parsed.units[0].content.includes("## H2"));
	});

	test("コードブロックがある場合: 実質コンテンツとして認識", () => {
		const md = `# H1

\`\`\`
code
\`\`\`

## H2

本文`;

		const parsed = markdownParser.parse(md, testConfig);

		// コードブロックがあるのでH1とH2は独立
		assert.strictEqual(parsed.units.length, 2);
		assert.ok(parsed.units[0].content.includes("H1"));
		assert.ok(parsed.units[1].content.includes("H2"));
	});

	test("リストがある場合: 実質コンテンツとして認識", () => {
		const md = `# H1

- item1
- item2

## H2

本文`;

		const parsed = markdownParser.parse(md, testConfig);

		// リストがあるのでH1とH2は独立
		assert.strictEqual(parsed.units.length, 2);
		assert.ok(parsed.units[0].content.includes("H1"));
		assert.ok(parsed.units[1].content.includes("H2"));
	});
});
