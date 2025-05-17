import * as assert from "node:assert";
import {
	HashCalculator,
	calculateHash,
} from "../../../core/hash/hash-calculator";

suite("HashCalculator", () => {
	test("テキストのハッシュが8文字で返されること", () => {
		const calculator = new HashCalculator();
		const text = "Hello, World!";
		const hash = calculator.calculate(text);
		assert.strictEqual(hash.length, 8); // デフォルトの長さは8
	});

	test("空のテキストに対して固定ハッシュ00000000が返されること", () => {
		const calculator = new HashCalculator();
		const hash = calculator.calculate("");
		assert.strictEqual(hash, "00000000"); // 空テキスト用の固定ハッシュ
	});

	test("正規化なしで8文字のハッシュが返されること", () => {
		const calculator = new HashCalculator();
		const text = "Hello, World!";
		const hash = calculator.calculate(text, false);
		assert.strictEqual(hash.length, 8);
	});
});

suite("calculateHash", () => {
	test("デフォルトの計算機を使用してハッシュが計算されること", () => {
		const text = "Hello, World!";
		const hash = calculateHash(text);
		assert.strictEqual(hash.length, 8);
	});
});
