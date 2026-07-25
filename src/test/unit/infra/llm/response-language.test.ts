import * as assert from "node:assert";
import { getDisplayLanguageCode, getResponseLanguage } from "../../../../infra/llm/response-language";

declare global {
	var __vscodeMockLanguage: string | undefined;
}

suite("response-language（AI応答の記述言語）", () => {
	teardown(() => {
		global.__vscodeMockLanguage = undefined;
	});

	test("VS Code の表示言語コードを小文字で返す", () => {
		global.__vscodeMockLanguage = "pt-BR";
		assert.strictEqual(getDisplayLanguageCode(), "pt-br");
	});

	test("表示言語が取得できないときは en にフォールバックする", () => {
		global.__vscodeMockLanguage = "";
		assert.strictEqual(getDisplayLanguageCode(), "en");
	});

	test("既知の言語コードは「英語名 (コード)」形式になる", () => {
		assert.strictEqual(getResponseLanguage("ja"), "Japanese (ja)");
		assert.strictEqual(getResponseLanguage("zh-cn"), "Simplified Chinese (zh-cn)");
	});

	test("地域付きの未知コードは基底言語の名前を使う", () => {
		assert.strictEqual(getResponseLanguage("ja-jp"), "Japanese (ja-jp)");
	});

	test("未知の言語コードはコードのみを返す", () => {
		assert.strictEqual(getResponseLanguage("xx"), "xx");
	});

	test("引数省略時は VS Code の表示言語を使う", () => {
		global.__vscodeMockLanguage = "ja";
		assert.strictEqual(getResponseLanguage(), "Japanese (ja)");
	});
});
