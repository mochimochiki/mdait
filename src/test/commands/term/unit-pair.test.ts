/**
 * @file unit-pair.test.ts
 * @description UnitPair型とユーティリティ関数のテスト
 */

import { strict as assert } from "node:assert";
import { MdaitUnit } from "../../../core/markdown/mdait-unit";
import { MdaitMarker } from "../../../core/markdown/mdait-marker";
import { UnitPair } from "../../../commands/term/unit-pair";

suite("UnitPair", () => {
	const mockSourceUnit = new MdaitUnit(
		new MdaitMarker("abc123"),
		"見出し",
		1,
		"# 見出し\n\nソースコンテンツ",
		0,
		2,
	);

	const mockTargetUnit = new MdaitUnit(
		new MdaitMarker("def456", "abc123"),
		"Heading",
		1,
		"# Heading\n\nTarget content",
		0,
		2,
	);

	const mockNeedTranslateUnit = new MdaitUnit(
		new MdaitMarker("ghi789", "abc123", "translate"),
		"Heading",
		1,
		"# Heading\n\nNot yet translated",
		0,
		2,
	);

	test("ソースのみでペアを作成できる", () => {
		const pair = UnitPair.create(mockSourceUnit, undefined);

		assert.strictEqual(pair.source, mockSourceUnit);
		assert.strictEqual(pair.target, undefined);
	});

	test("ソースとターゲットでペアを作成できる", () => {
		const pair = UnitPair.create(mockSourceUnit, mockTargetUnit);

		assert.strictEqual(pair.source, mockSourceUnit);
		assert.strictEqual(pair.target, mockTargetUnit);
	});

	test("hasTargetが翻訳済みターゲットの場合trueを返す", () => {
		const pairWithTarget = UnitPair.create(mockSourceUnit, mockTargetUnit);

		assert.strictEqual(UnitPair.hasTarget(pairWithTarget), true);
	});

	test("hasTargetがターゲットなしの場合falseを返す", () => {
		const pairWithoutTarget = UnitPair.create(mockSourceUnit, undefined);

		assert.strictEqual(UnitPair.hasTarget(pairWithoutTarget), false);
	});

	test("hasTargetがneed:translateのターゲットの場合falseを返す", () => {
		const pairWithNeedTranslate = UnitPair.create(mockSourceUnit, mockNeedTranslateUnit);

		assert.strictEqual(UnitPair.hasTarget(pairWithNeedTranslate), false);
	});

	test("getCharCountがソースのみの文字数を正しく計算する", () => {
		const pair = UnitPair.create(mockSourceUnit, undefined);
		const charCount = UnitPair.getCharCount(pair);

		assert.strictEqual(charCount, mockSourceUnit.content.length);
	});

	test("getCharCountがソースとターゲットの合計文字数を正しく計算する", () => {
		const pair = UnitPair.create(mockSourceUnit, mockTargetUnit);
		const charCount = UnitPair.getCharCount(pair);

		const expected = mockSourceUnit.content.length + mockTargetUnit.content.length;
		assert.strictEqual(charCount, expected);
	});
});
