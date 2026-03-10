import * as assert from "node:assert";
import { SentenceAligner } from "../../../commands/tm/sentence-aligner";
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

suite("SentenceAligner", () => {
	suite("parseResponse", () => {
		let aligner: SentenceAligner;

		setup(() => {
			aligner = new SentenceAligner(new MockAIService());
		});

		test("正常なJSON配列をパースできる", () => {
			const response = JSON.stringify([
				{ source: "Hello world.", target: "こんにちは世界。" },
				{ source: "Good bye.", target: "さようなら。" },
			]);

			const result = aligner.parseResponse(response);

			assert.strictEqual(result.length, 2);
			assert.strictEqual(result[0].source, "Hello world.");
			assert.strictEqual(result[0].target, "こんにちは世界。");
			assert.strictEqual(result[1].source, "Good bye.");
			assert.strictEqual(result[1].target, "さようなら。");
		});

		test("JSONコードブロック付きレスポンスをパースできる", () => {
			const response = `\`\`\`json\n${JSON.stringify([{ source: "Test sentence.", target: "テスト文。" }])}\n\`\`\``;

			const result = aligner.parseResponse(response);

			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0].source, "Test sentence.");
			assert.strictEqual(result[0].target, "テスト文。");
		});

		test("空のソースまたはターゲットはフィルタされる", () => {
			const response = JSON.stringify([
				{ source: "Valid.", target: "有効。" },
				{ source: "", target: "空ソース" },
				{ source: "空ターゲット", target: "" },
				{ source: "  ", target: "空白のみ" },
			]);

			const result = aligner.parseResponse(response);

			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0].source, "Valid.");
		});

		test("配列でないレスポンスは空配列を返す", () => {
			const result = aligner.parseResponse('{"not": "array"}');
			assert.strictEqual(result.length, 0);
		});

		test("不正なJSONは空配列を返す", () => {
			const result = aligner.parseResponse("this is not json");
			assert.strictEqual(result.length, 0);
		});

		test("不正な要素（source/target欠落）はスキップされる", () => {
			const response = JSON.stringify([
				{ source: "Valid.", target: "有効。" },
				{ source: "Missing target" },
				{ target: "Missing source" },
				"not an object",
			]);

			const result = aligner.parseResponse(response);

			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0].source, "Valid.");
		});
	});

	suite("alignSentences", () => {
		test("AIServiceにプロンプトを送信してレスポンスをパースする", async () => {
			const mockAI = new MockAIService();
			mockAI.response = JSON.stringify([
				{ source: "Download the installer.", target: "インストーラーをダウンロードします。" },
			]);

			const aligner = new SentenceAligner(mockAI);
			const result = await aligner.alignSentences(
				"Download the installer.",
				"インストーラーをダウンロードします。",
				"en",
				"ja",
			);

			assert.strictEqual(mockAI.callCount, 1);
			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0].source, "Download the installer.");
			assert.strictEqual(result[0].target, "インストーラーをダウンロードします。");
		});
	});
});
