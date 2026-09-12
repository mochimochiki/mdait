/**
 * 競合の判定の AI 呼び出し層のテスト（roadmap-v04 P02）。
 *
 * ここが持つ約束は「**決まらなかった件は決まらないまま返す**」である。迷った件も、
 * 形式が読めなかった件も、問い合わせが失敗した件も、無理に片方を採らずに人へ回す。
 */

import { strict as assert } from "node:assert";
import { ConflictJudge, JUDGE_BATCH_SIZE, buildConflictsBlock } from "../../../../commands/conflict/conflict-judge";
import type { PendingChoice } from "../../../../commands/conflict/resolution-plan";
import type { AIMessage, AIService } from "../../../../infra/llm/ai-service";
import type { PromptParts } from "../../../../prompts";

/** 送られた内容を記録して、決められた答えを返す偽の AI */
class FakeAi implements AIService {
	readonly systemPrompts: string[] = [];
	readonly userMessages: string[] = [];
	constructor(private readonly replies: string[]) {}

	async sendMessage(systemPrompt: string, messages: AIMessage[]): Promise<string> {
		this.systemPrompts.push(systemPrompt);
		this.userMessages.push(messages.map((m) => m.content).join("\n"));
		const reply = this.replies[Math.min(this.systemPrompts.length - 1, this.replies.length - 1)];
		if (reply === "THROW") {
			throw new Error("provider is down");
		}
		return reply;
	}
}

const parts = (variables: Record<string, string | undefined>): PromptParts => ({
	system: "SYSTEM",
	userContext: `USER ${variables.conflicts ?? ""}`,
	isLegacy: false,
});

const choice = (key: string, ours: string, theirs: string, base?: string): PendingChoice => ({
	key,
	label: key,
	oursText: ours,
	theirsText: theirs,
	baseText: base,
});

const context = { targetName: "翻訳メモリ" };

suite("競合の判定を AI に任せる", () => {
	test("二択の答えを鍵へ戻す", async () => {
		const ai = new FakeAi(['{"decisions":[{"index":1,"side":"theirs","reason":"用語集に合う"}]}']);
		const judge = new ConflictJudge(ai, (_id, v) => parts(v));

		const found = await judge.judge([choice("k1", "私", "相手")], context);

		assert.equal(found.decided.get("k1"), "theirs");
		assert.equal(found.reasons.get("k1"), "用語集に合う");
		assert.equal(found.undecidedCount, 0);
	});

	test("迷った件は決めない", async () => {
		const ai = new FakeAi(['{"decisions":[{"index":1,"side":"unsure","reason":"どちらも妥当"}]}']);
		const judge = new ConflictJudge(ai, (_id, v) => parts(v));

		const found = await judge.judge([choice("k1", "私", "相手")], context);

		assert.equal(found.decided.size, 0);
		assert.equal(found.undecidedCount, 1);
	});

	test("問い合わせが失敗したら、全件を人へ回す", async () => {
		const ai = new FakeAi(["THROW"]);
		const judge = new ConflictJudge(ai, (_id, v) => parts(v));

		const found = await judge.judge([choice("k1", "私", "相手"), choice("k2", "私2", "相手2")], context);

		assert.equal(found.decided.size, 0);
		assert.equal(found.undecidedCount, 2);
	});

	test("まるごと読めなければ1度だけ問い直し、system prompt は変えない", async () => {
		const ai = new FakeAi(["わかりません", '{"decisions":[{"index":1,"side":"ours","reason":"ok"}]}']);
		const judge = new ConflictJudge(ai, (_id, v) => parts(v));

		const found = await judge.judge([choice("k1", "私", "相手")], context);

		assert.equal(ai.systemPrompts.length, 2, "問い直していない");
		assert.deepEqual(new Set(ai.systemPrompts), new Set(["SYSTEM"]), "system prompt が変わっている");
		assert.match(ai.userMessages[1], /RETRY INSTRUCTION/);
		assert.equal(found.decided.get("k1"), "ours");
	});

	test("一部だけ読めたときは問い直さない（残りは人へ回す）", async () => {
		// 問い直しは費用と時間がかかる。1件でも読めたなら、残りは人が決めればよい
		const ai = new FakeAi(['{"decisions":[{"index":1,"side":"ours","reason":"ok"},{"index":2,"side":"merged"}]}']);
		const judge = new ConflictJudge(ai, (_id, v) => parts(v));

		const found = await judge.judge([choice("k1", "a", "b"), choice("k2", "c", "d")], context);

		assert.equal(ai.systemPrompts.length, 1, "問い直している");
		assert.equal(found.decided.size, 1);
		assert.equal(found.undecidedCount, 1);
	});

	test("件数が多ければ、決められた数ずつに分けて問い合わせる", async () => {
		const items = Array.from({ length: JUDGE_BATCH_SIZE + 3 }, (_, i) => choice(`k${i}`, "a", "b"));
		const ai = new FakeAi(['{"decisions":[]}']);
		const judge = new ConflictJudge(ai, (_id, v) => parts(v));

		await judge.judge(items, context);

		assert.equal(ai.systemPrompts.length, 2);
	});

	test("取り消されたら、そこで止める", async () => {
		const items = Array.from({ length: JUDGE_BATCH_SIZE + 3 }, (_, i) => choice(`k${i}`, "a", "b"));
		const ai = new FakeAi(['{"decisions":[]}']);
		const judge = new ConflictJudge(ai, (_id, v) => parts(v));

		const found = await judge.judge(items, context, {
			isCancellationRequested: true,
			onCancellationRequested: () => ({ dispose: () => undefined }),
		});

		assert.equal(ai.systemPrompts.length, 0);
		assert.equal(found.undecidedCount, items.length);
	});

	suite("AI へ渡す材料", () => {
		test("両側と、祖先があれば祖先も渡す", () => {
			const block = buildConflictsBlock([choice("k1", "私", "相手", "もと")], context);

			assert.match(block, /<ours>私<\/ours>/);
			assert.match(block, /<theirs>相手<\/theirs>/);
			assert.match(block, /<base>もと<\/base>/);
		});

		test("祖先が無ければ base のタグを出さない", () => {
			const block = buildConflictsBlock([choice("k1", "私", "相手")], context);

			assert.doesNotMatch(block, /<base>/);
		});

		test("番号はその回の中での1始まり（長い鍵を写させない）", () => {
			const block = buildConflictsBlock([choice("very-long-key-aaaa", "a", "b")], context);

			assert.match(block, /<conflict index="1">/);
			assert.doesNotMatch(block, /very-long-key-aaaa<\/ours>/);
		});

		test("値に山括弧が入っていてもタグを壊さない", () => {
			const block = buildConflictsBlock([choice("k1", "<b>強調</b>", "相手")], context);

			assert.match(block, /&lt;b&gt;強調&lt;\/b&gt;/);
		});

		test("用語集と TM は、あるときだけ添える", () => {
			const withExtras = buildConflictsBlock([choice("k1", "a", "b")], {
				...context,
				termsJson: '[{"en":"cache"}]',
				tmReferences: "過去の訳",
			});

			assert.match(withExtras, /<terms>/);
			assert.match(withExtras, /<tmReferences>/);
			assert.doesNotMatch(buildConflictsBlock([choice("k1", "a", "b")], context), /<terms>|<tmReferences>/);
		});
	});
});
