import * as assert from "node:assert";
import * as vscode from "vscode";
import { PairVerifier } from "../../../../commands/ai-sync/pair-verifier";
import type { AIMessage, AIService } from "../../../../infra/llm/ai-service";
import { PromptProvider } from "../../../../prompts";

/** 応答列を順番に返し、呼び出しを記録するスタブAIService */
class StubAIService implements AIService {
	public readonly calls: Array<{ system: string; user: string }> = [];
	private readonly responses: string[];

	constructor(responses: string[]) {
		this.responses = responses;
	}

	async sendMessage(
		systemPrompt: string,
		messages: AIMessage[],
		_cancellationToken?: vscode.CancellationToken,
	): Promise<string> {
		const last = messages[messages.length - 1];
		this.calls.push({ system: systemPrompt, user: String(last.content) });
		const index = Math.min(this.calls.length - 1, this.responses.length - 1);
		return this.responses[index];
	}
}

function buildVerifier(aiService: AIService, maxRetries = 2): PairVerifier {
	const promptProvider = PromptProvider.getInstance();
	return new PairVerifier(aiService, (id, variables) => promptProvider.getPromptParts(id, variables), maxRetries);
}

const request = {
	sourceLang: "ja",
	targetLang: "en",
	sourceText: "## セクションA\n\n本文A。",
	targetText: "## Section A\n\nContent A.",
};

const validMatch = '{"verdict": "match", "confidence": 0.95, "issues": [], "reason": "Complete."}';

suite("PairVerifier（AI呼び出しとリトライ）", () => {
	teardown(() => {
		PromptProvider.dispose();
	});

	test("正常応答で verdict を返し fallback にならない", async () => {
		const stub = new StubAIService([validMatch]);
		const result = await buildVerifier(stub).verify(request);
		assert.strictEqual(result.fallback, false);
		assert.strictEqual(result.parsed.verdict, "match");
		assert.strictEqual(result.parsed.confidence, 0.95);
		assert.strictEqual(stub.calls.length, 1);
	});

	test("user message にソース・ターゲット本文が含まれ system は静的である", async () => {
		const stub = new StubAIService([validMatch]);
		await buildVerifier(stub).verify(request);
		assert.ok(stub.calls[0].user.includes(request.sourceText));
		assert.ok(stub.calls[0].user.includes(request.targetText));
		assert.ok(!stub.calls[0].system.includes(request.sourceText));
	});

	test("不正JSONの後のリトライで RETRY INSTRUCTION が付与され成功する", async () => {
		const stub = new StubAIService(["not a json", validMatch]);
		const result = await buildVerifier(stub).verify(request);
		assert.strictEqual(result.fallback, false);
		assert.strictEqual(result.parsed.verdict, "match");
		assert.strictEqual(stub.calls.length, 2);
		assert.ok(!stub.calls[0].user.includes("RETRY INSTRUCTION"));
		assert.ok(stub.calls[1].user.includes("RETRY INSTRUCTION"));
	});

	test("リトライ間で system prompt が不変である（プレフィックスキャッシュ維持）", async () => {
		const stub = new StubAIService(['{"verdict": "bogus"}', validMatch]);
		await buildVerifier(stub).verify(request);
		assert.strictEqual(stub.calls.length, 2);
		assert.strictEqual(stub.calls[0].system, stub.calls[1].system);
	});

	test("リトライ上限到達で uncertain / confidence 0 のフォールバックを返す", async () => {
		const stub = new StubAIService(["broken response"]);
		const result = await buildVerifier(stub, 2).verify(request);
		assert.strictEqual(result.fallback, true);
		assert.strictEqual(result.parsed.verdict, "uncertain");
		assert.strictEqual(result.parsed.confidence, 0);
		// 初回 + リトライ2回 = 3回呼ばれる
		assert.strictEqual(stub.calls.length, 3);
	});

	test("キャンセル要求で中断される", async () => {
		const cts = new vscode.CancellationTokenSource();
		cts.cancel();
		const stub = new StubAIService([validMatch]);
		await assert.rejects(
			async () => await buildVerifier(stub).verify(request, cts.token),
			/cancelled/i,
		);
		assert.strictEqual(stub.calls.length, 0);
	});
});
