// AI へ「前回の訳文」を渡すのは、原文が改訂されたときだけ。
//
// 初回同期で作られる訳文ユニットの中身は `createEmptyTargetUnit` が丸写しした
// 原文そのもので、しかも from が付く。条件を from の有無にすると初回翻訳でも
// 「原文が改訂されました。前回の訳文を活かしてください」という枠つきで
// 原文を送り返すことになる（実測で user メッセージの 45%）。
//
// あわせて、参考として添える文（周辺テキスト・参考用の前回訳文）から
// コードブロックの中身を伏せることも固定する。訳す本文だけプレースホルダに
// 置き換わっていると、AI からは同じ内容が二つの姿で現れ、そこが変更点に見える。

import { strict as assert } from "node:assert";
import { resolvePreviousTranslation } from "../../../../commands/trans/trans-command";
import { TranslationContext } from "../../../../commands/trans/translation-context";
import { AITranslator, CODE_BLOCK_OMITTED_MARK, elideCodeBlocks } from "../../../../commands/trans/translator";
import { MdaitMarker } from "../../../../core/markdown/mdait-marker";
import { MdaitUnit } from "../../../../core/markdown/mdait-unit";
import type { AIMessage, AIService } from "../../../../infra/llm/ai-service";
import type { PromptParts } from "../../../../prompts/prompt-provider";

/** need を指定して訳文ユニットを1つ作る */
function targetUnit(need: string | null, content: string): MdaitUnit {
	const marker = new MdaitMarker("aaaaaaaa", "bbbbbbbb", need);
	return new MdaitUnit(marker, "見出し", 2, content, 0, 1);
}

/** 送った user message を控えるだけの偽 AI */
class CapturingAIService implements AIService {
	readonly calls: Array<{ systemPrompt: string; messages: AIMessage[] }> = [];
	constructor(private readonly response: string) {}
	async sendMessage(systemPrompt: string, messages: AIMessage[]): Promise<string> {
		this.calls.push({ systemPrompt, messages });
		return this.response;
	}
}

/** 渡された変数をそのまま user context に並べるテンプレート */
function echoParts(variables?: Record<string, string | undefined>): PromptParts {
	const lines = Object.entries(variables ?? {})
		.filter(([, value]) => value !== undefined && value !== "")
		.map(([key, value]) => `<${key}>${value}</${key}>`);
	return { system: "SYSTEM", userContext: lines.join("\n"), isLegacy: false };
}

suite("前回の訳文を参考として送る条件", () => {
	test("初回翻訳（need:translate）では前回の訳文を送らない", () => {
		// 初回同期直後の訳文ユニットは中身が原文の丸写し
		const unit = targetUnit("translate", "# 見出し\n\n本文です。");
		assert.strictEqual(resolvePreviousTranslation(unit), undefined);
	});

	test("原文が改訂されたとき（need:revise）だけ前回の訳文を送る", () => {
		const unit = targetUnit("revise@cccccccc", "# Heading\n\nTranslated body.");
		assert.strictEqual(resolvePreviousTranslation(unit), "# Heading\n\nTranslated body.");
	});

	test("取り込み待ち（need:review）では前回の訳文を送らない", () => {
		const unit = targetUnit("review", "# Heading\n\nAdopted body.");
		assert.strictEqual(resolvePreviousTranslation(unit), undefined);
	});

	test("need の付いていない訳文ユニットでも前回の訳文を送らない", () => {
		const unit = targetUnit(null, "# Heading\n\nTranslated body.");
		assert.strictEqual(resolvePreviousTranslation(unit), undefined);
	});
});

suite("参考として添える文のコードブロック", () => {
	test("参考文のコードブロックは目印ひとつに畳まれる", () => {
		const text = ["説明の行", "", "```js", 'console.log("hi");', "```", "", "続きの行"].join("\n");
		assert.strictEqual(
			elideCodeBlocks(text),
			["説明の行", "", CODE_BLOCK_OMITTED_MARK, "", "続きの行"].join("\n"),
		);
	});

	test("畳んだ目印は復元用のプレースホルダと取り違えない形をしている", () => {
		assert.ok(!/__CODE_BLOCK_PLACEHOLDER_\d+__/.test(CODE_BLOCK_OMITTED_MARK));
	});

	test("参考文が無ければ何も足さない", () => {
		assert.strictEqual(elideCodeBlocks(undefined), undefined);
	});

	test("周辺テキストと参考用の前回訳文はコードブロックを伏せて送る", async () => {
		const service = new CapturingAIService('{"translation": "ok", "termSuggestions": []}');
		const translator = new AITranslator(service, "ja", (_id, variables) => echoParts(variables));

		const context = new TranslationContext();
		context.previousTexts = [["前の章", "", "```js", 'console.log("prev");', "```"].join("\n")];
		context.previousTranslation = ["Previous heading", "", "```js", 'console.log("old");', "```"].join("\n");

		await translator.translate("本文\n\n```js\nconsole.log(1);\n```", "ja", "en", context);

		const sent = service.calls[0].messages[0].content as string;
		const reference = sent.slice(0, sent.indexOf("=== SOURCE TEXT ==="));
		assert.ok(!reference.includes("```"), "参考文に生のコードブロックが残っている");
		assert.ok(reference.includes(CODE_BLOCK_OMITTED_MARK), "参考文に伏せた目印が無い");
	});

	test("差分パッチでは前回訳文を生のまま送る（1行ずつ突き合わせる土台なので畳めない）", async () => {
		const service = new CapturingAIService('{"targetPatch": "=a", "termSuggestions": []}');
		const translator = new AITranslator(service, "ja", (_id, variables) => echoParts(variables));

		const previous = ["Previous heading", "", "```js", 'console.log("old");', "```"].join("\n");
		const context = new TranslationContext();
		context.previousTexts = [["前の章", "", "```js", 'console.log("prev");', "```"].join("\n")];
		context.previousTranslation = previous;
		context.sourceDiff = "-old\n+new";

		await translator.translateRevisionPatch("本文", "ja", "en", context);

		const sent = service.calls[0].messages[0].content as string;
		assert.ok(
			sent.includes(`<previousTranslation>${previous}</previousTranslation>`),
			"前回訳文が生のまま渡っていない",
		);
		// 周辺テキストのほうは畳まれている
		assert.ok(sent.includes(`<surroundingText>`));
		const surrounding = sent.slice(sent.indexOf("<surroundingText>"), sent.indexOf("</surroundingText>"));
		assert.ok(!surrounding.includes("```"), "周辺テキストに生のコードブロックが残っている");
		assert.ok(surrounding.includes(CODE_BLOCK_OMITTED_MARK));
	});
});
