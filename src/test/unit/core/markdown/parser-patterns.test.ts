// Markdownパーサーのfixture駆動パターンテスト
// 特殊Markdown構文と見出しレベル分割を網羅的に検証する

import { strict as assert } from "node:assert";
import type { Configuration } from "../../../../infra/config/configuration";
import { markdownParser } from "../../../../core/markdown/parser";
import { loadFixtures } from "../../fixtures/fixture-loader";

function makeConfig(level: number): Configuration {
	return { sync: { level } } as unknown as Configuration;
}

const fixtures = loadFixtures("markdown-patterns");

suite("MarkdownParser パターンテスト", () => {
	suite("A. 特殊Markdown構文", () => {
		for (const fixture of fixtures.filter(f => f.name.startsWith("a"))) {
			test(`${fixture.name}: ${fixture.metadata.description}`, () => {
				const config = makeConfig(fixture.metadata.syncLevel);
				const parsed = markdownParser.parse(fixture.markdown, config);

				assert.strictEqual(
					parsed.units.length,
					fixture.metadata.expectedUnits,
					`${fixture.name}: ユニット数が期待値と異なる`,
				);

				// ラウンドトリップ冪等性
				const stringified = markdownParser.stringify(parsed);
				const reparsed = markdownParser.parse(stringified, config);
				assert.strictEqual(
					reparsed.units.length,
					parsed.units.length,
					`${fixture.name}: ラウンドトリップ後のユニット数が変化`,
				);
				const restringified = markdownParser.stringify(reparsed);
				assert.strictEqual(stringified, restringified, `${fixture.name}: ラウンドトリップ非冪等`);
			});
		}
	});

	suite("B. 見出しレベル×sync.level", () => {
		for (const fixture of fixtures.filter(f => f.name.startsWith("b"))) {
			test(`${fixture.name}: ${fixture.metadata.description}`, () => {
				const config = makeConfig(fixture.metadata.syncLevel);
				const parsed = markdownParser.parse(fixture.markdown, config);

				assert.strictEqual(
					parsed.units.length,
					fixture.metadata.expectedUnits,
					`${fixture.name}: ユニット数が期待値と異なる`,
				);

				// ラウンドトリップ冪等性
				const stringified = markdownParser.stringify(parsed);
				const reparsed = markdownParser.parse(stringified, config);
				assert.strictEqual(
					reparsed.units.length,
					parsed.units.length,
					`${fixture.name}: ラウンドトリップ後のユニット数が変化`,
				);
				const restringified = markdownParser.stringify(reparsed);
				assert.strictEqual(stringified, restringified, `${fixture.name}: ラウンドトリップ非冪等`);
			});
		}
	});

	suite("C. フロントマター組み合わせ", () => {
		for (const fixture of fixtures.filter(f => f.name.startsWith("c"))) {
			test(`${fixture.name}: ${fixture.metadata.description}`, () => {
				const config = makeConfig(fixture.metadata.syncLevel);
				const parsed = markdownParser.parse(fixture.markdown, config);

				assert.strictEqual(
					parsed.units.length,
					fixture.metadata.expectedUnits,
					`${fixture.name}: ユニット数が期待値と異なる`,
				);

				// C01: フロントマターあり
				if (fixture.name === "c01-fm-with-table") {
					assert.ok(parsed.frontMatter, `${fixture.name}: フロントマターが検出されるべき`);
				}

				// C02: フロントマターなし
				if (fixture.name === "c02-no-fm-with-table") {
					assert.strictEqual(parsed.frontMatter, undefined, `${fixture.name}: フロントマターが無いはず`);
				}

				// C03: FM値がconfig値より優先される
				if (fixture.name === "c03-fm-level-override") {
					assert.ok(parsed.frontMatter, `${fixture.name}: フロントマターが検出されるべき`);
				}

				// ラウンドトリップ冪等性
				const stringified = markdownParser.stringify(parsed);
				const reparsed = markdownParser.parse(stringified, config);
				assert.strictEqual(
					reparsed.units.length,
					parsed.units.length,
					`${fixture.name}: ラウンドトリップ後のユニット数が変化`,
				);
				const restringified = markdownParser.stringify(reparsed);
				assert.strictEqual(stringified, restringified, `${fixture.name}: ラウンドトリップ非冪等`);
			});
		}
	});

	suite("D. エッジケース", () => {
		for (const fixture of fixtures.filter(f => f.name.startsWith("d"))) {
			test(`${fixture.name}: ${fixture.metadata.description}`, () => {
				const config = makeConfig(fixture.metadata.syncLevel);
				const parsed = markdownParser.parse(fixture.markdown, config);

				assert.strictEqual(
					parsed.units.length,
					fixture.metadata.expectedUnits,
					`${fixture.name}: ユニット数が期待値と異なる`,
				);

				// ラウンドトリップ冪等性（空ドキュメントは除外）
				if (fixture.metadata.expectedUnits > 0) {
					const stringified = markdownParser.stringify(parsed);
					const reparsed = markdownParser.parse(stringified, config);
					assert.strictEqual(
						reparsed.units.length,
						parsed.units.length,
						`${fixture.name}: ラウンドトリップ後のユニット数が変化`,
					);
					const restringified = markdownParser.stringify(reparsed);
					assert.strictEqual(stringified, restringified, `${fixture.name}: ラウンドトリップ非冪等`);
				}
			});
		}
	});
});
