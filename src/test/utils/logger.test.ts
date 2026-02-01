import * as assert from "node:assert";
import { LogLevel, formatError, parseLogLevel } from "../../utils/logger";

suite("LogLevel", () => {
	test("DEBUGは10であること", () => {
		assert.strictEqual(LogLevel.DEBUG, 10);
	});

	test("INFOは20であること", () => {
		assert.strictEqual(LogLevel.INFO, 20);
	});

	test("WARNは30であること", () => {
		assert.strictEqual(LogLevel.WARN, 30);
	});

	test("ERRORは40であること", () => {
		assert.strictEqual(LogLevel.ERROR, 40);
	});

	test("ログレベルの大小関係が正しいこと", () => {
		assert.ok(LogLevel.DEBUG < LogLevel.INFO);
		assert.ok(LogLevel.INFO < LogLevel.WARN);
		assert.ok(LogLevel.WARN < LogLevel.ERROR);
	});
});

suite("parseLogLevel", () => {
	test("'DEBUG'がLogLevel.DEBUGに変換されること", () => {
		assert.strictEqual(parseLogLevel("DEBUG"), LogLevel.DEBUG);
	});

	test("'INFO'がLogLevel.INFOに変換されること", () => {
		assert.strictEqual(parseLogLevel("INFO"), LogLevel.INFO);
	});

	test("'WARN'がLogLevel.WARNに変換されること", () => {
		assert.strictEqual(parseLogLevel("WARN"), LogLevel.WARN);
	});

	test("'ERROR'がLogLevel.ERRORに変換されること", () => {
		assert.strictEqual(parseLogLevel("ERROR"), LogLevel.ERROR);
	});

	test("小文字でも変換されること", () => {
		assert.strictEqual(parseLogLevel("debug"), LogLevel.DEBUG);
		assert.strictEqual(parseLogLevel("info"), LogLevel.INFO);
		assert.strictEqual(parseLogLevel("warn"), LogLevel.WARN);
		assert.strictEqual(parseLogLevel("error"), LogLevel.ERROR);
	});

	test("不明な文字列はINFOにフォールバックすること", () => {
		assert.strictEqual(parseLogLevel("unknown"), LogLevel.INFO);
		assert.strictEqual(parseLogLevel(""), LogLevel.INFO);
	});
});

suite("formatError", () => {
	test("Errorオブジェクトがname, message, stackを含むオブジェクトに変換されること", () => {
		const error = new Error("Test error message");
		const formatted = formatError(error);

		assert.ok("name" in formatted);
		assert.ok("message" in formatted);
		assert.ok("stack" in formatted);
		assert.strictEqual((formatted as { name: string }).name, "Error");
		assert.strictEqual((formatted as { message: string }).message, "Test error message");
	});

	test("カスタムエラークラスも正しく変換されること", () => {
		class CustomError extends Error {
			constructor(message: string) {
				super(message);
				this.name = "CustomError";
			}
		}

		const error = new CustomError("Custom error message");
		const formatted = formatError(error);

		assert.strictEqual((formatted as { name: string }).name, "CustomError");
		assert.strictEqual((formatted as { message: string }).message, "Custom error message");
	});

	test("オブジェクトがそのまま返されること", () => {
		const obj = { code: 500, details: "Internal error" };
		const formatted = formatError(obj);

		assert.deepStrictEqual(formatted, obj);
	});

	test("文字列がvalue属性を持つオブジェクトに変換されること", () => {
		const formatted = formatError("string error");

		assert.ok("value" in formatted);
		assert.strictEqual((formatted as { value: string }).value, "string error");
	});

	test("数値がvalue属性を持つオブジェクトに変換されること", () => {
		const formatted = formatError(42);

		assert.ok("value" in formatted);
		assert.strictEqual((formatted as { value: string }).value, "42");
	});

	test("nullがvalue属性を持つオブジェクトに変換されること", () => {
		const formatted = formatError(null);

		assert.ok("value" in formatted);
		assert.strictEqual((formatted as { value: string }).value, "null");
	});

	test("undefinedがvalue属性を持つオブジェクトに変換されること", () => {
		const formatted = formatError(undefined);

		assert.ok("value" in formatted);
		assert.strictEqual((formatted as { value: string }).value, "undefined");
	});
});
