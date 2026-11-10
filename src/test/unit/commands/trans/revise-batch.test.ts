/**
 * @file revise-batch.test.ts
 * @description 同じファイルの改訂をまとめて頼む経路（ADR-261110-01）の単体テスト
 *
 * - 答えの検証（`validateRevisionBatchResponse`）: ユニットごとにパッチか NO CHANGE か
 * - 翻訳サービス（`AITranslator.translateRevisionBatch` / `canTranslateRevisionBatch`）
 */

import { strict as assert } from "node:assert";
import { validateRevisionBatchResponse } from "../../../../commands/trans/response-validator";
import { TranslationContext } from "../../../../commands/trans/translation-context";
import { AITranslator, PLAIN_PROMPT_CONFIG } from "../../../../commands/trans/translator";
import type { AIMessage, AIService } from "../../../../infra/llm/ai-service";
import { UnusableAIResponseError } from "../../../../infra/llm/unusable-response";
import { PromptIds } from "../../../../prompts/defaults";

class ScriptedAI implements AIService {
	readonly calls: { system: string; user: string }[] = [];
	constructor(private readonly reply: (user: string, call: number) => string) {}
	async sendMessage(systemPrompt: string, messages: AIMessage[]): Promise<string> {
		const last = messages[messages.length - 1];
		const user = Array.isArray(last.content) ? last.content.join("") : String(last.content);
		this.calls.push({ system: systemPrompt, user });
		return this.reply(user, this.calls.length);
	}
}

const usedPromptIds: string[] = [];
const promptParts = (id: string) => {
	usedPromptIds.push(id);
	return { system: `system:${id}`, userContext: "ctx", isLegacy: false };
};

const items = [
	{
		source: "## 電池\n\n最大 48 時間動きます。",
		previousTranslation: "## Battery\n\nIt runs for up to 72 hours.",
		sourceDiff: "@@ -1,3 +1,3 @@\n ## 電池\n \n-最大 72 時間動きます。\n+最大 48 時間動きます。\n",
	},
	{
		source: "## 設置\n\n作業のための空間を空けてください。",
		previousTranslation: "## Installation\n\nLeave space for work.",
		sourceDiff: "@@ -1,3 +1,3 @@\n ## 設置\n \n-作業のための空間を空けて下さい。\n+作業のための空間を空けてください。\n",
		tmReferences: '1. [90% match] Source: "空間を空けてください。"\n   Translation: "Leave space."',
	},
];

suite("改訂をまとめて頼む経路（ADR-261110-01）", () => {
	suite("validateRevisionBatchResponse", () => {
		test("ユニットごとに、パッチか NO CHANGE の1行を受け入れる", () => {
			const result = validateRevisionBatchResponse(
				"@@@ UNIT 1 @@@\nREPLACE 3\nIt runs for up to 48 hours.\nEND\n@@@ UNIT 2 @@@\nNO CHANGE",
				2,
			);
			assert.strictEqual(result.valid, true);
			assert.deepStrictEqual(result.parsed, ["REPLACE 3\nIt runs for up to 48 hours.\nEND", "NO CHANGE"]);
		});

		test("パッチとして読めないユニットがあれば、どのユニットかを添えてやり直しを頼む", () => {
			const result = validateRevisionBatchResponse("@@@ UNIT 1 @@@\nNO CHANGE\n@@@ UNIT 2 @@@\nI think it is fine.", 2);
			assert.strictEqual(result.valid, false);
			assert.match(result.error?.message ?? "", /^Unit 2:/);
			assert.strictEqual(result.error?.retryable, true);
		});

		test("渡した行番号を本文に書き戻したユニットがあれば、当てる前にやり直しを頼む", () => {
			const result = validateRevisionBatchResponse(
				"@@@ UNIT 1 @@@\nREPLACE 3\n3\tIt runs for up to 48 hours.\nEND\n@@@ UNIT 2 @@@\nNO CHANGE",
				2,
			);
			assert.strictEqual(result.error?.code, "LINE_NUMBER_ECHO");
		});

		test("END で閉じていないブロックがあれば、当てはめる前にやり直しを頼む", () => {
			const result = validateRevisionBatchResponse("@@@ UNIT 1 @@@\nREPLACE 3\nUpdated text\n@@@ UNIT 2 @@@\nNO CHANGE", 2);
			assert.strictEqual(result.valid, false);
			assert.match(result.error?.message ?? "", /^Unit 1: .*unterminated-block/);
			assert.strictEqual(result.error?.retryable, true);
		});

		test("区切りがそろっていなければ、やり直しを頼める失敗にする", () => {
			const result = validateRevisionBatchResponse("REPLACE 3\nx\nEND", 2);
			assert.strictEqual(result.error?.code, "UNIT_SEPARATOR_MISMATCH");
		});
	});

	suite("AITranslator.translateRevisionBatch", () => {
		test("改訂を1回で送り、各ユニットの答えをパッチか NO CHANGE として返す", async () => {
			usedPromptIds.length = 0;
			const ai = new ScriptedAI(
				() => "@@@ UNIT 1 @@@\nREPLACE 3\nIt runs for up to 48 hours.\nEND\n@@@ UNIT 2 @@@\nNO CHANGE",
			);
			const translator = new AITranslator(ai, "ja", promptParts);
			const results = await translator.translateRevisionBatch(items, "ja", "en", new TranslationContext());
			assert.strictEqual(ai.calls.length, 1);
			assert.deepStrictEqual(usedPromptIds, [PromptIds.TRANS_REVISE_PATCH_BATCH]);
			const user = ai.calls[0].user;
			assert.match(user, /@@@ UNIT 1 @@@\nPrevious Translation[^\n]*\n1\t## Battery\n2\t\n3\tIt runs for up to 72 hours\./);
			assert.match(user, /@@@ UNIT 2 @@@/);
			assert.match(user, /Revised Source:\n## 電池/);
			assert.match(user, /Translation Memory Reference[^\n]*\n1\. \[90% match\]/);
			assert.ok(!user.includes("Surrounding Text"), "前後のユニットの訳文は付けない");
			assert.deepStrictEqual(results[1], { noChange: true });
			const first = results[0];
			assert.ok(!first.noChange);
			assert.strictEqual(first.format, "linenum");
			assert.strictEqual(first.targetPatch, "REPLACE 3\nIt runs for up to 48 hours.\nEND");
		});

		test("改訂後の原文のコードブロックは目印にして送り、前の訳文のコードブロックは生のまま渡す", async () => {
			const code = "```lua\nlocal x = 1\n```";
			const ai = new ScriptedAI(
				() => "@@@ UNIT 1 @@@\nINSERT AFTER 1\n__CODE_BLOCK_PLACEHOLDER_0__\nEND",
			);
			const translator = new AITranslator(ai, "ja", promptParts);
			const results = await translator.translateRevisionBatch(
				[{ source: `## A\n\n${code}`, previousTranslation: `## A\n\n${code}`, sourceDiff: "x" }],
				"ja",
				"en",
				new TranslationContext(),
			);
			const user = ai.calls[0].user;
			const revised = user.slice(user.indexOf("Revised Source:"));
			assert.ok(!revised.includes("local x = 1"), "改訂後の原文のコードを送っている");
			assert.ok(user.slice(0, user.indexOf("Revised Source:")).includes("local x = 1"), "前の訳文のコードを畳んでいる");
			const first = results[0];
			assert.ok(!first.noChange);
			assert.ok(first.targetPatch.includes(code), "目印をコードへ戻していない");
		});

		test("分けられない答えは送り直し、2回目で読めれば採る", async () => {
			const ai = new ScriptedAI((_user, call) =>
				call === 1 ? "REPLACE 3\nx\nEND" : "@@@ UNIT 1 @@@\nNO CHANGE\n@@@ UNIT 2 @@@\nNO CHANGE",
			);
			const translator = new AITranslator(ai, "ja", promptParts, undefined, 2);
			const results = await translator.translateRevisionBatch(items, "ja", "en", new TranslationContext());
			assert.strictEqual(ai.calls.length, 2);
			assert.match(ai.calls[1].user, /RETRY INSTRUCTION/);
			assert.deepStrictEqual(results, [{ noChange: true }, { noChange: true }]);
		});

		test("送り直しても読めなければ、使えない答えとして投げる（呼び出し側が1件ずつへ戻る）", async () => {
			const ai = new ScriptedAI(() => "no separators");
			const translator = new AITranslator(ai, "ja", promptParts, undefined, 1);
			await assert.rejects(
				translator.translateRevisionBatch(items, "ja", "en", new TranslationContext()),
				(error: unknown) => error instanceof UnusableAIResponseError,
			);
			assert.strictEqual(ai.calls.length, 2);
		});
	});

	suite("AITranslator.canTranslateRevisionBatch", () => {
		const ai = new ScriptedAI(() => "");
		test("指示文を上書きしていなければ、まとめて頼む", () => {
			assert.strictEqual(new AITranslator(ai, "ja", promptParts).canTranslateRevisionBatch(), true);
		});
		test("trans.revisePatch だけを上書きしているときは、まとめない（旧来の形式で読むため）", () => {
			const custom = (id: string) => id === PromptIds.TRANS_REVISE_PATCH;
			assert.strictEqual(new AITranslator(ai, "ja", promptParts, undefined, 1, custom).canTranslateRevisionBatch(), false);
		});
		test("trans.revisePatchBatch も上書きしていれば、まとめて頼む", () => {
			const custom = (id: string) => id === PromptIds.TRANS_REVISE_PATCH || id === PromptIds.TRANS_REVISE_PATCH_BATCH;
			assert.strictEqual(new AITranslator(ai, "ja", promptParts, undefined, 1, custom).canTranslateRevisionBatch(), true);
		});
		test("Markdown でないファイルの構成ではまとめない", () => {
			assert.strictEqual(
				new AITranslator(ai, "ja", promptParts, PLAIN_PROMPT_CONFIG).canTranslateRevisionBatch(),
				false,
			);
		});
	});
});
