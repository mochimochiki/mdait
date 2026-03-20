import * as assert from "node:assert";
import { LLMTmEntryGenerator } from "../../../commands/tm/tm-entry-generator";
import type { AIMessage, AIService } from "../../../llm/ai-service";

/**
 * テスト用AIServiceモック。sendMessageに渡されたプロンプトを記録し、
 * 事前に設定したレスポンスを返す。
 */
class MockAIService implements AIService {
	/** sendMessage呼び出し回数 */
	callCount = 0;
	/** 最後に渡されたsystemPrompt */
	lastSystemPrompt = "";
	/** 返却するレスポンス */
	response = "[]";

	async sendMessage(systemPrompt: string, _messages: AIMessage[], _cancellationToken?: unknown): Promise<string> {
		this.callCount++;
		this.lastSystemPrompt = systemPrompt;
		return this.response;
	}
}

suite("LLMTmEntryGenerator", () => {
	suite("parseResponse", () => {
		let generator: LLMTmEntryGenerator;

		setup(() => {
			generator = new LLMTmEntryGenerator(new MockAIService());
		});

		test("正常なTM登録計画配列をパースできる", () => {
			const response = JSON.stringify([
				{ type: "new", tuid: "-", primary: "Hello world.", local: "こんにちは世界。" },
				{ type: "update", tuid: "abcd1234", primary: "Good bye.", local: "さようなら。" },
			]);

			const result = generator.parseResponse(response);

			assert.strictEqual(result.length, 2);
			assert.strictEqual(result[0].type, "new");
			assert.strictEqual(result[0].primary, "Hello world.");
			assert.strictEqual(result[0].local, "こんにちは世界。");
			assert.strictEqual(result[1].type, "update");
			assert.strictEqual(result[1].tuid, "abcd1234");
		});

		test("JSONコードブロック付きレスポンスをパースできる", () => {
			const response = `\`\`\`json\n${JSON.stringify([{ type: "new", tuid: "-", primary: "Test sentence.", local: "テスト文。" }])}\n\`\`\``;

			const result = generator.parseResponse(response);

			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0].primary, "Test sentence.");
			assert.strictEqual(result[0].local, "テスト文。");
		});

		test("空のprimaryまたはlocalを含む応答は fail-closed で空配列になる", () => {
			const response = JSON.stringify([
				{ type: "new", tuid: "-", primary: "Valid.", local: "有効。" },
				{ type: "new", tuid: "-", primary: "", local: "空primary" },
				{ type: "update", tuid: "abcd1234", primary: "空local", local: "" },
			]);

			const result = generator.parseResponse(response);

			assert.deepStrictEqual(result, []);
		});

		test("配列でないレスポンスは空配列を返す", () => {
			const result = generator.parseResponse('{"not": "array"}');
			assert.strictEqual(result.length, 0);
		});

		test("不正なJSONは空配列を返す", () => {
			const result = generator.parseResponse("this is not json");
			assert.strictEqual(result.length, 0);
		});

		test("不正な要素（type/primary/local欠落）を含む応答は fail-closed で空配列になる", () => {
			const response = JSON.stringify([
				{ type: "new", tuid: "-", primary: "Valid.", local: "有効。" },
				{ type: "update", tuid: "abcd1234", primary: "Missing local" },
				{ type: "new", tuid: "-", local: "Missing primary" },
				"not an object",
			]);

			const result = generator.parseResponse(response);

			assert.deepStrictEqual(result, []);
		});

		test("余計なプロパティを含む応答は fail-closed で空配列になる", () => {
			const response = JSON.stringify([{ type: "new", tuid: "-", primary: "Valid.", local: "有効。", extra: true }]);

			const result = generator.parseResponse(response);

			assert.deepStrictEqual(result, []);
		});
	});

	suite("generateEntries", () => {
		test("AIServiceにプロンプトを送信してレスポンスをパースする", async () => {
			const mockAI = new MockAIService();
			mockAI.response = JSON.stringify([
				{ type: "new", tuid: "-", primary: "Download the installer.", local: "インストーラーをダウンロードします。" },
			]);

			const generator = new LLMTmEntryGenerator(mockAI);
			const result = await generator.generateEntries({
				primaryLang: "en",
				localLang: "ja",
				primaryUnit: "Download the installer.",
				localUnit: "インストーラーをダウンロードします。",
				ExistingTmEntries: [],
				requiredUpdateTuids: [],
			});

			assert.strictEqual(mockAI.callCount, 1);
			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0].primary, "Download the installer.");
			assert.strictEqual(result[0].local, "インストーラーをダウンロードします。");
			assert.ok(mockAI.lastSystemPrompt.includes("Primary language: en"));
			assert.ok(mockAI.lastSystemPrompt.includes("Local language: ja"));
		});
	});
});
