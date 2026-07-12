import * as assert from "node:assert";
import * as vscode from "vscode";
import { PairVerifier } from "../../../../commands/ai-review/pair-verifier";
import type { VerifyBatchRequest } from "../../../../commands/ai-review/pair-verifier";
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

function makeRequest(): VerifyBatchRequest {
	return {
		sourceLang: "ja",
		targetLang: "en",
		pairs: [
			{ index: 1, sourceText: "## セクションA\n\n本文A。", targetText: "## Section A\n\nContent A." },
			{ index: 2, sourceText: "## セクションB\n\n本文B。", targetText: "## Section B\n\nContent B." },
		],
	};
}

function batchResponse(...indices: number[]): string {
	return JSON.stringify({
		results: indices.map((index) => ({
			index,
			verdict: "match",
			confidence: 0.95,
			issues: [],
			reason: "Complete.",
		})),
	});
}

suite("PairVerifier.verifyBatch（バッチAI呼び出しとリトライ）", () => {
	teardown(() => {
		PromptProvider.dispose();
	});

	test("正常応答で全ペアの verdict が index で対応付いて返る", async () => {
		const stub = new StubAIService([batchResponse(1, 2)]);
		const results = await buildVerifier(stub).verifyBatch(makeRequest());
		assert.strictEqual(stub.calls.length, 1);
		assert.strictEqual(results.size, 2);
		assert.strictEqual(results.get(1)?.parsed.verdict, "match");
		assert.strictEqual(results.get(1)?.fallback, false);
		assert.strictEqual(results.get(2)?.fallback, false);
	});

	test("user message に <pair index> ブロックが含まれ system は静的である", async () => {
		const stub = new StubAIService([batchResponse(1, 2)]);
		await buildVerifier(stub).verifyBatch(makeRequest());
		const call = stub.calls[0];
		assert.ok(call.user.includes('<pair index="1">'));
		assert.ok(call.user.includes('<pair index="2">'));
		assert.ok(call.user.includes("本文A。"));
		assert.ok(!call.system.includes("本文A。"), "本文は system（キャッシュ対象）に載らない");
	});

	test("terms / tmReferences / humanNote がペア内ブロックとして user message に載る", async () => {
		const stub = new StubAIService([batchResponse(1, 2)]);
		const request = makeRequest();
		request.pairs[0].termsJson = '[{"term":"キャッシュ","translation":"cache"}]';
		request.pairs[0].tmReferences = '1. Source: "a"\n   Translation: "b"';
		request.pairs[1].humanNote = "Intentionally condensed.";
		await buildVerifier(stub).verifyBatch(request);
		const user = stub.calls[0].user;
		const pair1 = user.slice(user.indexOf('<pair index="1">'), user.indexOf('<pair index="2">'));
		const pair2 = user.slice(user.indexOf('<pair index="2">'));
		assert.ok(pair1.includes("<terms>"));
		assert.ok(pair1.includes("<tmReferences>"));
		assert.ok(!pair1.includes("<humanNote>"));
		assert.ok(pair2.includes("<humanNote>"));
		assert.ok(pair2.includes("Intentionally condensed."));
		assert.ok(!pair2.includes("<terms>"));
	});

	test("不完全応答の後のリトライで RETRY INSTRUCTION（欠落 index つき）が付与され成功する", async () => {
		const stub = new StubAIService([batchResponse(1), batchResponse(1, 2)]);
		const results = await buildVerifier(stub).verifyBatch(makeRequest());
		assert.strictEqual(stub.calls.length, 2);
		assert.ok(!stub.calls[0].user.includes("RETRY INSTRUCTION"));
		assert.ok(stub.calls[1].user.includes("RETRY INSTRUCTION"));
		assert.ok(stub.calls[1].user.includes("2"), "欠落 index がリトライ指示に含まれること");
		assert.strictEqual(results.get(2)?.fallback, false);
	});

	test("リトライ間で system prompt が不変である（プレフィックスキャッシュ維持）", async () => {
		const stub = new StubAIService(["broken", batchResponse(1, 2)]);
		await buildVerifier(stub).verifyBatch(makeRequest());
		assert.strictEqual(stub.calls.length, 2);
		assert.strictEqual(stub.calls[0].system, stub.calls[1].system);
	});

	test("リトライ枯渇時は部分受理: 有効エントリは採用され欠落分のみ fallback になる", async () => {
		// 常に index 1 のみ返す
		const stub = new StubAIService([batchResponse(1)]);
		const results = await buildVerifier(stub, 2).verifyBatch(makeRequest());
		assert.strictEqual(stub.calls.length, 3, "初回 + リトライ2回");
		assert.strictEqual(results.get(1)?.fallback, false, "有効だった index 1 は採用されること");
		assert.strictEqual(results.get(1)?.parsed.verdict, "match");
		assert.strictEqual(results.get(2)?.fallback, true, "欠落した index 2 はフォールバックされること");
		assert.strictEqual(results.get(2)?.parsed.verdict, "uncertain");
		assert.strictEqual(results.get(2)?.parsed.confidence, 0);
	});

	test("全応答が不正でも全ペア分の fallback 結果が返る", async () => {
		const stub = new StubAIService(["completely broken"]);
		const results = await buildVerifier(stub, 1).verifyBatch(makeRequest());
		assert.strictEqual(results.size, 2);
		assert.strictEqual(results.get(1)?.fallback, true);
		assert.strictEqual(results.get(2)?.fallback, true);
	});

	test("キャンセル要求で中断される", async () => {
		const cts = new vscode.CancellationTokenSource();
		cts.cancel();
		const stub = new StubAIService([batchResponse(1, 2)]);
		await assert.rejects(async () => await buildVerifier(stub).verifyBatch(makeRequest(), cts.token), /cancelled/i);
		assert.strictEqual(stub.calls.length, 0);
	});
});
