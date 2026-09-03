import * as assert from "node:assert";
import { TranslationContext } from "../../../../commands/trans/translation-context";
import { AITranslator } from "../../../../commands/trans/translator";
import type { AIMessage, AIService } from "../../../../infra/llm/ai-service";
import { PromptIds } from "../../../../prompts/defaults";

/**
 * 改訂パッチの形式の決まり方（ADR-260903-01）。
 *
 * 組み込みの指示文は行番号方式。**利用者が指示文を上書きしているときだけ旧形式**として読む
 * — 既存の上書きは `=`/`-`/`+` に向けて書かれており、新形式として読めば必ず失敗するため。
 *
 * ここで守りたいのは「形式を中身から推測しない」こと。推測させると、一方の形式のつもりで
 * 書かれた答えをもう一方として読めてしまい、当たったように見えて本文が壊れる。
 */
class StubAIService implements AIService {
	public readonly systemPrompts: string[] = [];
	constructor(private readonly answer: string) {}
	async sendMessage(systemPrompt: string, _messages: AIMessage[]): Promise<string> {
		this.systemPrompts.push(systemPrompt);
		return this.answer;
	}
}

function makeContext(): TranslationContext {
	const context = new TranslationContext();
	context.previousTranslation = ["## Features", "- Sync support"].join("\n");
	context.sourceDiff = "-old\n+new";
	return context;
}

const stubParts = { system: "stub", userContext: "", isLegacy: true } as const;

suite("改訂パッチの形式は指示文の出どころで決まる", () => {
	test("組み込みの指示文なら行番号方式として読む", async () => {
		const service = new StubAIService("REPLACE 2\n- Real-time sync\nEND");
		const translator = new AITranslator(
			service,
			"ja",
			() => ({ ...stubParts }),
			undefined,
			0,
			() => false,
		);

		const result = await translator.translateRevisionPatch("本文", "ja", "en", makeContext());

		assert.strictEqual(result.format, "linenum");
	});

	test("利用者が上書きしていたら旧形式として読む（既存の上書きを壊さない）", async () => {
		const service = new StubAIService('{"targetPatch": "=## Features\\n-- Sync support\\n+- Real-time sync"}');
		const translator = new AITranslator(
			service,
			"ja",
			() => ({ ...stubParts }),
			undefined,
			0,
			() => true,
		);

		const result = await translator.translateRevisionPatch("本文", "ja", "en", makeContext());

		assert.strictEqual(result.format, "prefixed");
		assert.ok(result.targetPatch.includes("=## Features"), "旧形式のパッチが取り出せていない");
	});

	test("上書きの有無は、改訂用の指示文の ID で問い合わせる", async () => {
		const asked: string[] = [];
		const service = new StubAIService("REPLACE 2\nx\nEND");
		const translator = new AITranslator(
			service,
			"ja",
			() => ({ ...stubParts }),
			undefined,
			0,
			(id) => {
				asked.push(id);
				return false;
			},
		);

		await translator.translateRevisionPatch("本文", "ja", "en", makeContext());

		assert.ok(
			asked.includes(PromptIds.TRANS_REVISE_PATCH),
			`改訂用の ID で問い合わせていない（実際: ${asked.join(", ")}）`,
		);
	});

	test("指定が無ければ行番号方式（既定を組み込み側に寄せる）", async () => {
		const service = new StubAIService("REPLACE 2\nx\nEND");
		const translator = new AITranslator(service, "ja", () => ({ ...stubParts }));

		const result = await translator.translateRevisionPatch("本文", "ja", "en", makeContext());

		assert.strictEqual(result.format, "linenum");
	});

	test("行番号方式では、旧形式の答えを受け取らずにやり直しを頼む", async () => {
		// 黙って当てにいくと、prefixed の寛容な当てはめ器が「読めてしまう」
		const service = new StubAIService('{"targetPatch": "=## Features\\n-- Sync support"}');
		const translator = new AITranslator(
			service,
			"ja",
			() => ({ ...stubParts }),
			undefined,
			0,
			() => false,
		);

		const error = await translator.translateRevisionPatch("本文", "ja", "en", makeContext()).then(
			() => undefined,
			(e: unknown) => e,
		);

		assert.ok(error, "旧形式の答えを受け入れてしまった");
	});
});
