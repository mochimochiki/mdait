import * as assert from "node:assert";
import type * as vscode from "vscode";
import { SectionAligner } from "../../../../commands/adopt/section-aligner";
import type { SectionAlignRequest } from "../../../../commands/adopt/section-aligner";
import type { AIMessage, AIService } from "../../../../infra/llm/ai-service";
import { isOperationCancelled } from "../../../../infra/errors/operation-cancelled";
import { PromptProvider } from "../../../../prompts";

/** 応答列を順に返し、system と messages 全体を記録するスタブAIService */
class StubAIService implements AIService {
	public readonly calls: Array<{ system: string; messages: AIMessage[] }> = [];
	private readonly responses: string[];

	constructor(responses: string[]) {
		this.responses = responses;
	}

	async sendMessage(
		systemPrompt: string,
		messages: AIMessage[],
		_cancellationToken?: vscode.CancellationToken,
	): Promise<string> {
		this.calls.push({ system: systemPrompt, messages: messages.map((m) => ({ ...m })) });
		const index = Math.min(this.calls.length - 1, this.responses.length - 1);
		return this.responses[index];
	}
}

function buildAligner(ai: AIService, limits = {}): SectionAligner {
	const promptProvider = PromptProvider.getInstance();
	return new SectionAligner(ai, (id, variables) => promptProvider.getPromptParts(id, variables), limits);
}

function request(): SectionAlignRequest {
	return {
		sourceLang: "ja",
		targetLang: "en",
		sourceSkeletons: [
			{ index: 0, level: 2, title: "A", digest: "aaa", length: 10 },
			{ index: 1, level: 2, title: "B", digest: "bbb", length: 12 },
		],
		targetSkeletons: [
			{ index: 0, level: 2, title: "A", digest: "aaa", length: 10 },
			{ index: 1, level: 2, title: "B", digest: "bbb", length: 12 },
		],
		correspondence: [
			{ sourceIndex: 0, targetIndex: 0, locked: false },
			{ sourceIndex: 1, targetIndex: 1, locked: false },
		],
		sourceBodies: ["## A\n\naaa body", "## B\n\nbbb body"],
		targetBodies: ["## A\n\naaa body", "## B\n\nbbb body"],
	};
}

suite("SectionAligner（二段トリアージ・リトライ）", () => {
	teardown(() => {
		PromptProvider.dispose();
	});

	test("ok 応答は no-op（corrections空・fallbackなし・1ラウンド）", async () => {
		const ai = new StubAIService(['{"ok": true}']);
		const result = await buildAligner(ai).align(request());
		assert.strictEqual(result.fallback, false);
		assert.strictEqual(result.corrections.length, 0);
		assert.strictEqual(result.rounds, 1);
		assert.strictEqual(ai.calls.length, 1);
	});

	test("corrections 応答をそのまま返す（1ラウンド）", async () => {
		const ai = new StubAIService(['{"corrections": [{"sourceIndex": 1, "targetIndex": 0, "confidence": 0.9}]}']);
		const result = await buildAligner(ai).align(request());
		assert.strictEqual(result.fallback, false);
		assert.strictEqual(result.corrections.length, 1);
		assert.strictEqual(result.rounds, 1);
	});

	test("needBodies で2ラウンド目に進み assistant ロールを含む多ターンになる", async () => {
		const ai = new StubAIService([
			'{"needBodies": [{"side": "source", "index": 0}]}',
			'{"corrections": [{"sourceIndex": 1, "targetIndex": 0, "confidence": 0.88}]}',
		]);
		const result = await buildAligner(ai).align(request());
		assert.strictEqual(result.rounds, 2);
		assert.strictEqual(result.fallback, false);
		assert.strictEqual(result.corrections.length, 1);
		assert.strictEqual(ai.calls.length, 2);
		// 2回目の呼び出しは user → assistant → user の多ターン
		const round2 = ai.calls[1].messages;
		assert.strictEqual(round2.length, 3);
		assert.strictEqual(round2[0].role, "user");
		assert.strictEqual(round2[1].role, "assistant");
		assert.strictEqual(round2[2].role, "user");
		// assistant にはラウンド1の生応答が入る
		assert.ok(String(round2[1].content).includes("needBodies"));
	});

	test("2ラウンド目も needBodies なら位置ベースへフォールバック", async () => {
		const ai = new StubAIService([
			'{"needBodies": [{"side": "source", "index": 0}]}',
			'{"needBodies": [{"side": "target", "index": 1}]}',
		]);
		const result = await buildAligner(ai).align(request());
		assert.strictEqual(result.fallback, true);
		assert.strictEqual(result.rounds, 2);
	});

	test("needBodies が上限Kを超えたら1ラウンドでフォールバック", async () => {
		const ai = new StubAIService([
			'{"needBodies": [{"side": "source", "index": 0}, {"side": "source", "index": 1}]}',
		]);
		const result = await buildAligner(ai, { maxNeedBodies: 1 }).align(request());
		assert.strictEqual(result.fallback, true);
		assert.strictEqual(result.rounds, 1);
		assert.strictEqual(ai.calls.length, 1, "本文追加ラウンドには進まない");
	});

	test("JSON不正はリトライ後にフォールバックする（system は不変）", async () => {
		const ai = new StubAIService(["garbage", "still garbage", "nope"]);
		const result = await buildAligner(ai).align(request());
		assert.strictEqual(result.fallback, true);
		assert.strictEqual(ai.calls.length, 3, "maxRetries=2 → 計3回");
		const systems = new Set(ai.calls.map((c) => c.system));
		assert.strictEqual(systems.size, 1, "system プロンプトはリトライ間で不変");
	});

	test("リトライ内で回復すれば corrections を返す", async () => {
		const ai = new StubAIService([
			"garbage",
			'{"corrections": [{"sourceIndex": 1, "targetIndex": 0, "confidence": 0.9}]}',
		]);
		const result = await buildAligner(ai).align(request());
		assert.strictEqual(result.fallback, false);
		assert.strictEqual(result.corrections.length, 1);
		assert.strictEqual(ai.calls.length, 2);
	});
});

/**
 * 取り消しの投げ方を固定する。
 *
 * 背景: ここは素の `new Error("AI align cancelled")` を投げていた。受け手（sync のワーカー）は
 * 中断だと見分けられず、利用者が押した取り消しが「1 failed」として数えられていた。
 * 中断を投げる層は `OperationCancelledError` だけを投げる（`infra/errors/operation-cancelled.ts`）。
 */
suite("SectionAligner（取り消しの投げ方）", () => {
	teardown(() => {
		PromptProvider.dispose();
	});

	/** 取り消し済みの合図 */
	function cancelledToken(): vscode.CancellationToken {
		return {
			isCancellationRequested: true,
			onCancellationRequested: () => ({ dispose: () => {} }),
		} as unknown as vscode.CancellationToken;
	}

	test("取り消し済みなら中断の型で投げること（素の Error では見分けられない）", async () => {
		const ai = new StubAIService(['{"ok": true}']);
		await assert.rejects(
			() => buildAligner(ai).align(request(), cancelledToken()),
			(thrown: unknown) => isOperationCancelled(thrown),
			"中断だと見分けられない例外を投げている",
		);
		assert.strictEqual(ai.calls.length, 0, "取り消したのに AI へ送っている");
	});
});
