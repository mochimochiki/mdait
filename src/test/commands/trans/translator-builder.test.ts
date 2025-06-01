import { strict as assert } from "node:assert";
import { TranslatorBuilder } from "../../../commands/trans/translator-builder";

suite("TranslatorBuilder", () => {
	test("デフォルト設定でTranslatorが構築されること", async () => {
		const builder = new TranslatorBuilder();
		const translator = await builder.build();

		assert.ok(translator);
		assert.strictEqual(typeof translator.translate, "function");
	});

	test("カスタム設定でTranslatorが構築されること", async () => {
		const builder = new TranslatorBuilder();
		const config = { provider: "default" };
		const translator = await builder.build(config);

		assert.ok(translator);
		assert.strictEqual(typeof translator.translate, "function");
	});

	test("翻訳機能が正常に動作すること", async () => {
		const builder = new TranslatorBuilder();
		const translator = await builder.build();
		const context = {
			previousText: "",
			nextText: "",
			glossary: "",
		};

		const result = await translator.translate("Hello", "en", "ja", context);

		assert.ok(result);
		assert.strictEqual(typeof result, "string");
		assert.ok(result.length > 0);
	});

	test("Ollamaプロバイダーが正常に構築されること", async () => {
		const builder = new TranslatorBuilder();
		const config = { provider: "ollama" };
		const translator = await builder.build(config);

		assert.ok(translator);
		assert.strictEqual(typeof translator.translate, "function");
	});

	test("VSCodeLMプロバイダーが正常に構築されること", async () => {
		const builder = new TranslatorBuilder();
		const config = { provider: "vscode-lm" };
		const translator = await builder.build(config);

		assert.ok(translator);
		assert.strictEqual(typeof translator.translate, "function");
	});

	test("サポートされていないプロバイダでエラーが発生すること", async () => {
		const builder = new TranslatorBuilder();
		const config = { provider: "unsupported-provider" };

		await assert.rejects(
			async () => {
				await builder.build(config);
			},
			{
				name: "Error",
				message: /Unsupported AI provider: unsupported-provider/,
			},
		);
	});
});
