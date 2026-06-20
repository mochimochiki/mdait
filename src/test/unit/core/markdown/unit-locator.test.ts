import * as assert from "node:assert";
import { MdaitMarker } from "../../../../core/markdown/mdait-marker";
import { MdaitUnit } from "../../../../core/markdown/mdait-unit";
import { findUnitAtLine } from "../../../../core/markdown/unit-locator";

/** テスト用ユニットを生成（startLine/endLine を指定） */
function makeUnit(hash: string, startLine: number, endLine: number): MdaitUnit {
	return new MdaitUnit(new MdaitMarker(hash), "title", 1, "# title", startLine, endLine);
}

suite("findUnitAtLine", () => {
	// 0-9, 10-19, 20-24 の3ユニット
	const units = [makeUnit("a", 0, 9), makeUnit("b", 10, 19), makeUnit("c", 20, 24)];

	test("ユニット範囲内の行で該当ユニットを返すこと", () => {
		assert.strictEqual(findUnitAtLine(units, 5)?.marker?.hash, "a");
		assert.strictEqual(findUnitAtLine(units, 15)?.marker?.hash, "b");
		assert.strictEqual(findUnitAtLine(units, 22)?.marker?.hash, "c");
	});

	test("開始行・終了行の境界を含むこと", () => {
		assert.strictEqual(findUnitAtLine(units, 0)?.marker?.hash, "a");
		assert.strictEqual(findUnitAtLine(units, 9)?.marker?.hash, "a");
		assert.strictEqual(findUnitAtLine(units, 10)?.marker?.hash, "b");
		assert.strictEqual(findUnitAtLine(units, 19)?.marker?.hash, "b");
	});

	test("範囲外の行では null を返すこと", () => {
		assert.strictEqual(findUnitAtLine(units, 25), null);
		assert.strictEqual(findUnitAtLine(units, 100), null);
	});

	test("空配列では null を返すこと", () => {
		assert.strictEqual(findUnitAtLine([], 0), null);
	});
});
