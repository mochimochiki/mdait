/**
 * @file unit-batch.test.ts
 * @description 新規翻訳のユニットをまとめて頼む経路（ADR-261109-01）の単体テスト
 *
 * - まとまりの組み方（`planBatches`）
 * - 答えの分け方（`splitBatchResponse` / `validateBatchTranslationResponse`）
 * - 翻訳サービス（`AITranslator.translateBatch` / `canTranslateBatch`）
 * - ユニットへの受け渡し（`BatchPrefetcher`）
 */

import { strict as assert } from "node:assert";
import { validateBatchTranslationResponse } from "../../../../commands/trans/response-validator";
import { BatchPrefetcher } from "../../../../commands/trans/trans-command";
import { TranslationContext } from "../../../../commands/trans/translation-context";
import {
	AITranslator,
	PLAIN_PROMPT_CONFIG,
	type TranslationResult,
	protectUnitsWithSharedNumbering,
} from "../../../../commands/trans/translator";
import { joinBatchSource, planBatches, splitBatchResponse } from "../../../../commands/trans/unit-batch";
import { MdaitMarker } from "../../../../core/markdown/mdait-marker";
import { MdaitUnit } from "../../../../core/markdown/mdait-unit";
import type { AIMessage, AIService } from "../../../../infra/llm/ai-service";
import { UnusableAIResponseError } from "../../../../infra/llm/unusable-response";
import { PromptIds } from "../../../../prompts/defaults";
import { PromptProvider } from "../../../../prompts/prompt-provider";

/** 受け取った依頼を覚え、決めた順に答えを返す AI */
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

/** 原文の行頭に EN: を付けて「訳した」ことにする。区切りの行と目印はそのまま返す */
function fakeTranslate(user: string): string {
	const body = user.includes("=== SOURCE TEXT ===\n") ? user.split("=== SOURCE TEXT ===\n")[1] : user;
	return body
		.split("\n")
		.map((line) => (line === "" || line.startsWith("@@@") || line.startsWith("__CODE_BLOCK") ? line : `EN: ${line}`))
		.join("\n");
}

const usedPromptIds: string[] = [];
const promptParts = (id: string) => {
	usedPromptIds.push(id);
	return { system: `system:${id}`, userContext: "ctx", isLegacy: false };
};

suite("まとめて訳す経路（ADR-261109-01）", () => {
	suite("planBatches", () => {
		const u = (position: number, length: number, eligible = true) => ({ position, length, eligible });

		test("分量の上限までは1つのまとまりにし、超えたら次のまとまりを始める", () => {
			assert.deepStrictEqual(planBatches([u(0, 1000), u(1, 1000), u(2, 1000), u(3, 400)], 2500), [[0, 1], [2, 3]]);
		});

		test("まとめないユニット（改訂など）は、まとまりを切り、自分はどこにも入らない", () => {
			assert.deepStrictEqual(planBatches([u(0, 100), u(1, 100, false), u(2, 100)], 2500), [[0], [2]]);
		});

		test("ファイルの中で隣り合っていないユニットは、別のまとまりにする", () => {
			assert.deepStrictEqual(planBatches([u(0, 100), u(1, 100), u(5, 100), u(6, 100)], 2500), [[0, 1], [2, 3]]);
		});

		test("1つで上限を超えるユニットは、それだけで1つのまとまりにする", () => {
			assert.deepStrictEqual(planBatches([u(0, 100), u(1, 5000), u(2, 100)], 2500), [[0], [1], [2]]);
		});
	});

	suite("splitBatchResponse", () => {
		test("区切りの行でユニットに分ける", () => {
			const text = joinBatchSource(["# A\n\nalpha", "## B\n\nbeta"]);
			assert.deepStrictEqual(splitBatchResponse(text, 2), ["# A\n\nalpha", "## B\n\nbeta"]);
		});

		test("先頭の区切りだけが抜けた答えは、その前の本文を1つ目のユニットとして受け入れる", () => {
			assert.deepStrictEqual(splitBatchResponse("# A\n\nalpha\n\n@@@ UNIT 2 @@@\n## B", 2), ["# A\n\nalpha", "## B"]);
		});

		test("1ユニットだけのまとまりは、区切りが無くても受け入れる", () => {
			assert.deepStrictEqual(splitBatchResponse("# A\n\nalpha", 1), ["# A\n\nalpha"]);
		});

		test("区切りがすべて抜けた答えは分けられない", () => {
			assert.strictEqual(splitBatchResponse("# A\n\nalpha\n\n## B\n\nbeta", 2), undefined);
		});

		test("区切りの順番が違う答えは分けられない", () => {
			assert.strictEqual(splitBatchResponse("@@@ UNIT 2 @@@\nb\n@@@ UNIT 1 @@@\na", 2), undefined);
		});

		test("訳が空のユニットがある答えは分けられない", () => {
			assert.strictEqual(splitBatchResponse("@@@ UNIT 1 @@@\na\n@@@ UNIT 2 @@@\n\n", 2), undefined);
		});

		test("区切りが全部そろっていても、1つ目の区切りの前に本文があれば分けられない", () => {
			assert.strictEqual(splitBatchResponse("intro\n@@@ UNIT 1 @@@\na\n@@@ UNIT 2 @@@\nb", 2), undefined);
		});
	});

	suite("validateBatchTranslationResponse", () => {
		test("答え全体を包むコードフェンスは剥がして受け入れる", () => {
			const result = validateBatchTranslationResponse("```markdown\n@@@ UNIT 1 @@@\na\n@@@ UNIT 2 @@@\nb\n```", 2);
			assert.strictEqual(result.valid, true);
			assert.strictEqual(result.parsed, "@@@ UNIT 1 @@@\na\n@@@ UNIT 2 @@@\nb");
		});

		test("JSON で答えたら、やり直しを頼める失敗にする", () => {
			const result = validateBatchTranslationResponse('{"translation": "a"}', 1);
			assert.strictEqual(result.valid, false);
			assert.strictEqual(result.error?.code, "JSON_IN_CONTENT");
			assert.strictEqual(result.error?.retryable, true);
		});

		test("区切りがそろっていなければ、やり直しを頼める失敗にする", () => {
			const result = validateBatchTranslationResponse("a\nb", 2);
			assert.strictEqual(result.error?.code, "UNIT_SEPARATOR_MISMATCH");
			assert.strictEqual(result.error?.retryable, true);
		});
	});

	suite("AITranslator.translateBatch", () => {
		const context = () => new TranslationContext(["# prev"], ["# next"], '[{"term":"本体","translation":"main unit"}]');

		test("まとめた原文を1回で送り、ユニットごとの訳に分けて返す。用語候補は求めない", async () => {
			usedPromptIds.length = 0;
			const ai = new ScriptedAI(fakeTranslate);
			const translator = new AITranslator(ai, "ja", promptParts);
			const results = await translator.translateBatch(["# 見出し\n\n本文1", "## 節\n\n本文2"], "ja", "en", context());
			assert.strictEqual(ai.calls.length, 1);
			assert.deepStrictEqual(usedPromptIds, [PromptIds.TRANS_TRANSLATE_BATCH]);
			assert.match(ai.calls[0].user, /@@@ UNIT 1 @@@\n# 見出し/);
			assert.match(ai.calls[0].user, /@@@ UNIT 2 @@@\n## 節/);
			assert.deepStrictEqual(
				results.map((r) => r.translatedText),
				["EN: # 見出し\n\nEN: 本文1", "EN: ## 節\n\nEN: 本文2"],
			);
			assert.ok(results.every((r) => (r.termSuggestions ?? []).length === 0));
		});

		test("コードブロックは目印にして送り、答えを分ける前に元へ戻す", async () => {
			const ai = new ScriptedAI(fakeTranslate);
			const translator = new AITranslator(ai, "ja", promptParts);
			const code = "```lua\nlocal x = 1\n```";
			const results = await translator.translateBatch([`# A\n\n${code}`, `## B\n\n${code}\n\n本文`], "ja", "en", context());
			assert.ok(!ai.calls[0].user.includes("local x = 1"), "コードブロックの中身を送っている");
			assert.ok(results[0].translatedText.includes(code));
			assert.ok(results[1].translatedText.includes(code));
			assert.ok(!results.some((r) => r.translatedText.includes("__CODE_BLOCK")));
		});

		test("コードの中に区切りに似た行があっても、分けてから戻すので答えを採れる", async () => {
			const ai = new ScriptedAI(fakeTranslate);
			const translator = new AITranslator(ai, "ja", promptParts);
			const code = "```text\n@@@ UNIT 2 @@@\n```";
			const results = await translator.translateBatch([`# A\n\n${code}`, "## B\n\nb"], "ja", "en", context());
			assert.strictEqual(ai.calls.length, 1);
			assert.ok(results[0].translatedText.includes(code));
			assert.match(results[1].translatedText, /EN: ## B/);
		});

		test("ユニットの頭にあるインデントのコードも、コードとして退避して送る", async () => {
			const ai = new ScriptedAI(fakeTranslate);
			const translator = new AITranslator(ai, "ja", promptParts);
			const indented = '    print("警告")';
			const results = await translator.translateBatch(["# A\n\na", `${indented}\n\nb`], "ja", "en", context());
			assert.ok(!ai.calls[0].user.includes("print("), "インデントのコードを送っている");
			assert.ok(results[1].translatedText.includes(indented));
		});

		test("区切りがそろっていない答えは送り直し、2回目で分けられれば採る", async () => {
			const ai = new ScriptedAI((user, call) => (call === 1 ? "EN: all mixed together" : fakeTranslate(user)));
			const translator = new AITranslator(ai, "ja", promptParts, undefined, 2);
			const results = await translator.translateBatch(["# A\n\na", "## B\n\nb"], "ja", "en", context());
			assert.strictEqual(ai.calls.length, 2);
			assert.match(ai.calls[1].user, /RETRY INSTRUCTION/);
			assert.strictEqual(results.length, 2);
		});

		test("コードブロックの目印を落とした答えは採らずに送り直す", async () => {
			const ai = new ScriptedAI((user, call) =>
				call === 1 ? fakeTranslate(user).replace(/__CODE_BLOCK_PLACEHOLDER_\d+__/g, "") : fakeTranslate(user),
			);
			const translator = new AITranslator(ai, "ja", promptParts, undefined, 2);
			const results = await translator.translateBatch(["# A\n\n```\nx\n```", "## B\n\nb"], "ja", "en", context());
			assert.strictEqual(ai.calls.length, 2);
			assert.ok(results[0].translatedText.includes("```\nx\n```"));
		});

		test("送り直しても分けられなければ、使えない答えとして投げる（呼び出し側が1件ずつへ戻る）", async () => {
			const ai = new ScriptedAI(() => "no separators here");
			const translator = new AITranslator(ai, "ja", promptParts, undefined, 1);
			await assert.rejects(
				translator.translateBatch(["# A\n\na", "## B\n\nb"], "ja", "en", context()),
				(error: unknown) => error instanceof UnusableAIResponseError,
			);
			assert.strictEqual(ai.calls.length, 2);
		});
	});

	suite("protectUnitsWithSharedNumbering", () => {
		test("ユニットごとに退避し、目印の番号はまとまりの中で通しにする", () => {
			const units = protectUnitsWithSharedNumbering(["```\na\n```", "x", "```\nb\n```\n\n```\nc\n```"], true);
			assert.deepStrictEqual(
				units.map((u) => u.placeholders),
				[["__CODE_BLOCK_PLACEHOLDER_0__"], [], ["__CODE_BLOCK_PLACEHOLDER_1__", "__CODE_BLOCK_PLACEHOLDER_2__"]],
			);
			assert.ok(units[2].text.includes("__CODE_BLOCK_PLACEHOLDER_2__"));
			assert.ok(!units[2].text.includes("__CODE_BLOCK_PLACEHOLDER_0__"));
		});
	});

	suite("追加指示（mdait-instructions.md）の対象", () => {
		teardown(() => PromptProvider.dispose());
		test("trans.translate を対象にした追加指示は、まとめて頼む指示文にも当てる", () => {
			PromptProvider.dispose();
			const provider = PromptProvider.getInstance();
			(provider as unknown as { instructionCache: unknown }).instructionCache = {
				content: "USE-BRITISH-SPELLING",
				targetPrompts: [PromptIds.TRANS_TRANSLATE],
			};
			assert.ok(provider.getPromptParts(PromptIds.TRANS_TRANSLATE_BATCH).system.includes("USE-BRITISH-SPELLING"));
			assert.ok(!provider.getPromptParts(PromptIds.TERM_DETECT_PAIRS).system.includes("USE-BRITISH-SPELLING"));
		});
	});

	suite("AITranslator.canTranslateBatch", () => {
		const ai = new ScriptedAI(fakeTranslate);
		test("指示文を上書きしていなければ、まとめて頼む", () => {
			assert.strictEqual(new AITranslator(ai, "ja", promptParts).canTranslateBatch(), true);
		});
		test("trans.translate だけを上書きしているときは、まとめない（上書きが効かなくなるため）", () => {
			const custom = (id: string) => id === PromptIds.TRANS_TRANSLATE;
			assert.strictEqual(new AITranslator(ai, "ja", promptParts, undefined, 1, custom).canTranslateBatch(), false);
		});
		test("trans.translateBatch も上書きしていれば、まとめて頼む", () => {
			const custom = (id: string) => id === PromptIds.TRANS_TRANSLATE || id === PromptIds.TRANS_TRANSLATE_BATCH;
			assert.strictEqual(new AITranslator(ai, "ja", promptParts, undefined, 1, custom).canTranslateBatch(), true);
		});
		test("Markdown でないファイルの構成ではまとめない", () => {
			assert.strictEqual(new AITranslator(ai, "ja", promptParts, PLAIN_PROMPT_CONFIG).canTranslateBatch(), false);
		});
	});

	suite("BatchPrefetcher", () => {
		const unit = (hash: string) => new MdaitUnit(new MdaitMarker(hash, null, "translate"), hash, 2, `## ${hash}`, 0, 0);
		const result = (text: string): TranslationResult => ({ translatedText: text });

		test("まとまりごとに1回だけ訳し、各ユニットへ自分の分を渡す", async () => {
			const [a, b, c] = [unit("a"), unit("b"), unit("c")];
			let runs = 0;
			const prefetcher = new BatchPrefetcher([[a, b], [c]], async (units) => {
				runs++;
				return units.map((u) => result(`EN ${u.title}`));
			});
			assert.strictEqual((await prefetcher.resultFor(a))?.translatedText, "EN a");
			assert.strictEqual((await prefetcher.resultFor(b))?.translatedText, "EN b");
			assert.strictEqual(runs, 1);
			assert.strictEqual((await prefetcher.resultFor(c))?.translatedText, "EN c");
			assert.strictEqual(runs, 2);
		});

		test("まとまりに入っていないユニットと、まとめた答えが使えなかったまとまりには何も渡さない", async () => {
			const [a, b] = [unit("a"), unit("b")];
			const prefetcher = new BatchPrefetcher([[a]], async () => undefined);
			assert.strictEqual(await prefetcher.resultFor(a), undefined);
			assert.strictEqual(await prefetcher.resultFor(b), undefined);
		});
	});
});
