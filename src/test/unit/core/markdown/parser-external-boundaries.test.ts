// parser の external 経路（markersFormBoundaries=false）の境界生成テスト
// external では境界は「見出しレベル≤閾値」＋「先頭本文ユニット」のみで、マーカーは境界を作らない

import { strict as assert } from "node:assert";
import { markdownParser } from "../../../../core/markdown/parser";
import type { Configuration } from "../../../../infra/config/configuration";

function makeConfig(level: number): Configuration {
	return { sync: { level } } as unknown as Configuration;
}

/** markersFormBoundaries=false の external provider 風スタブ（attach/detach は no-op） */
const externalLikeProvider = {
	mode: "external" as const,
	markersFormBoundaries: false,
	attachMarkers: () => {},
	detachMarkers: () => {},
	attachFrontMatter: () => {},
	detachFrontMatter: () => {},
};

suite("parser external 境界生成（markersFormBoundaries=false）", () => {
	test("マーカー無しドキュメントが見出し≤levelのみで境界化されること", () => {
		const doc = ["# 見出し1", "", "本文1。", "", "## 見出し2", "", "本文2。", ""].join("\n");
		const parsed = markdownParser.parse(doc, makeConfig(2), externalLikeProvider);

		assert.strictEqual(parsed.units.length, 2);
		assert.strictEqual(parsed.units[0].title, "見出し1");
		assert.strictEqual(parsed.units[1].title, "見出し2");
	});

	test("本文中に紛れたマーカーが境界を生成しないこと（防御）", () => {
		const doc = ["# 見出し1", "", "本文1。", "", "<!-- mdait abcd1234 -->", "", "続きの本文。", ""].join("\n");
		const parsed = markdownParser.parse(doc, makeConfig(2), externalLikeProvider);

		// マーカー単独境界が作られない → 見出し1 の1ユニットのみ
		assert.strictEqual(parsed.units.length, 1);
		assert.strictEqual(parsed.units[0].title, "見出し1");
		// マーカー由来の独立ユニットが生まれていないこと
		assert.ok(parsed.units.every((u) => u.title !== ""));
	});

	test("見出し前の先頭本文がユニットとして生成されること", () => {
		const doc = ["序文の本文。", "", "# 見出し1", "", "本文1。", ""].join("\n");
		const parsed = markdownParser.parse(doc, makeConfig(2), externalLikeProvider);

		assert.strictEqual(parsed.units.length, 2);
		// 先頭本文ユニット（見出しなし）
		assert.strictEqual(parsed.units[0].headingLevel, 0);
		assert.ok(parsed.units[0].content.includes("序文の本文。"));
		// 2番目は見出しユニット
		assert.strictEqual(parsed.units[1].title, "見出し1");
	});
});
