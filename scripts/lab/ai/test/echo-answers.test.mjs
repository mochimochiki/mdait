/*
 * 偽の AI（echo）が、翻訳以外の仕事にも答えられることのテスト。
 *
 * 指示文の形は `src/prompts/defaults.ts` の既定にそろえてある。指示文を書き換えて
 * ここが見分けられなくなったら、答えは翻訳（既定）に落ちる — 黙って嘘の答えを返さない
 * ことも、ここで固定しておく。
 */
import assert from "node:assert/strict";
import { EchoBackend } from "../lib/backends.mjs";
import { buildEchoAnswer, classifyEchoRequest } from "../lib/echo-answers.mjs";

const ask = (system, user) => [
	{ role: "system", content: system },
	{ role: "user", content: user },
];

const detectSourceOnlyPrompt = `You are a terminology extraction expert.

### Source Text
マイクロサービスアーキテクチャは分散システムの設計手法である。
各サービスは独立して配備できる。

### Output Format
Return a JSON array with this structure:
[
  {
    "sourceTerm": "term in ja",
    "variants": ["surface variations"],
    "context": "sentence containing the term"
  }
]`;

const detectPairsPrompt = `You are a terminology extraction expert.

### Translation Pairs
マイクロサービスアーキテクチャは分散システムの設計手法である。

### Output Format
[
  {
    "sourceTerm": "term in ja",
    "targetTerm": "term in en",
    "variants": [],
    "context": "sentence"
  }
]`;

const translateTermsPrompt = `You are a professional translator specializing in technical terminology.

Return JSON object mapping source terms to translated terms:
{
  "source term 1": "translated term 1"
}`;

const tmPrompt = `You are a senior professional translator and translation-memory (TM) curator.

<primaryLanguageUnit>
マイクロサービスは独立して配備できる設計である。
短い。
</primaryLanguageUnit>

<localLanguageUnit>
マイクロサービスは独立して配備できる設計である。 短い。 [MT]
</localLanguageUnit>

<ExistingTmEntries>
[]
</ExistingTmEntries>`;

suite("echo: 翻訳以外の仕事の見分け", () => {
	test("指示文の言い回しから仕事の種類を見分ける", () => {
		assert.equal(classifyEchoRequest(ask(detectSourceOnlyPrompt, "x")), "term-detect-source");
		assert.equal(classifyEchoRequest(ask(detectPairsPrompt, "x")), "term-detect-pairs");
		assert.equal(classifyEchoRequest(ask(translateTermsPrompt, "x")), "term-translate");
		assert.equal(classifyEchoRequest(ask(tmPrompt, "x")), "tm-pairs");
	});

	test("見分けが付かない仕事は翻訳として扱う", () => {
		assert.equal(classifyEchoRequest(ask("You are a professional translator.", "=== SOURCE TEXT ===\n本文")), "translation");
		assert.equal(buildEchoAnswer(ask("You are a professional translator.", "本文")), null);
	});
});

suite("echo: 用語を拾う", () => {
	test("原文に出てくる語だけを、JSON の配列で返す", () => {
		const answer = JSON.parse(buildEchoAnswer(ask(detectSourceOnlyPrompt, "Extract important terms.")));
		assert.ok(Array.isArray(answer));
		assert.ok(answer.length > 0, "1件以上返すこと");
		for (const term of answer) {
			assert.equal(typeof term.sourceTerm, "string");
			assert.ok(term.sourceTerm.length > 0);
			assert.ok(detectSourceOnlyPrompt.includes(term.sourceTerm), "原文に出てくる語であること");
			assert.ok(term.context.includes(term.sourceTerm), "context にその語が入っていること");
			assert.equal(term.targetTerm, undefined, "対訳なしの仕事では訳語を付けないこと");
		}
	});

	test("対訳ありの仕事では訳語も付ける", () => {
		const answer = JSON.parse(buildEchoAnswer(ask(detectPairsPrompt, "Extract important terms.")));
		assert.ok(answer.length > 0);
		for (const term of answer) {
			assert.equal(term.targetTerm, `${term.sourceTerm} [MT]`);
		}
	});

	test("同じ要求には毎回同じ答えを返す", () => {
		const once = buildEchoAnswer(ask(detectSourceOnlyPrompt, "Extract important terms."));
		const twice = buildEchoAnswer(ask(detectSourceOnlyPrompt, "Extract important terms."));
		assert.equal(once, twice);
	});
});

suite("echo: 訳語を埋める", () => {
	test("依頼文に並んだ語を、そのまま鍵にした対応表を返す", () => {
		const user = `Translate these ja terms to en:
- **マイクロサービス** (context: 分散システムの設計手法)
- **配備** (context: 独立して配備できる)`;
		const answer = JSON.parse(buildEchoAnswer(ask(translateTermsPrompt, user)));
		assert.deepEqual(answer, {
			マイクロサービス: "マイクロサービス [MT]",
			配備: "配備 [MT]",
		});
	});
});

suite("echo: 文の対を作る", () => {
	test("原文にも訳文にもそのまま入っている文だけを返す", () => {
		const answer = JSON.parse(buildEchoAnswer(ask(tmPrompt, "Create TM commit plan items.")));
		assert.ok(answer.length > 0, "1件以上返すこと");
		for (const item of answer) {
			assert.deepEqual(Object.keys(item).sort(), ["local", "primary", "tuid", "type"]);
			assert.equal(item.type, "new");
			assert.equal(item.tuid, "-");
			assert.ok(!item.primary.includes("\n"), "1行であること");
			assert.ok(tmPrompt.includes(item.primary), "原文の一部そのままであること");
			assert.ok(item.primary.length >= 12, "短すぎる文は返さないこと");
		}
	});

	test("短い文（TM に登録できないもの）は返さない", () => {
		const answer = JSON.parse(buildEchoAnswer(ask(tmPrompt, "Create TM commit plan items.")));
		assert.ok(!answer.some((item) => item.primary === "短い。"));
	});
});

suite("echo: 受け皿を通しても同じ答えになる", () => {
	test("EchoBackend が用語の一覧をそのまま返す", async () => {
		const backend = new EchoBackend({});
		const reply = await backend.respond({ messages: ask(detectSourceOnlyPrompt, "Extract important terms.") });
		assert.ok(Array.isArray(JSON.parse(reply.text)));
	});

	test("翻訳の仕事では、これまでどおり訳文を返す", async () => {
		const backend = new EchoBackend({});
		const reply = await backend.respond({
			messages: ask("You are a professional translator.", "=== SOURCE TEXT ===\n本文A"),
		});
		assert.equal(JSON.parse(reply.text).translation, "本文A [MT]");
	});
});
