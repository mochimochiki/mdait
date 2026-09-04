/**
 * @file frontmatter-context.test.ts
 * @description frontmatter を訳すときに渡す文脈のテスト
 *
 * frontmatter（題名・説明）の翻訳だけ、用語集も翻訳メモリも渡っていなかった。
 * 本文ユニットと非Markdown は両方とも渡していて、AIレビューは frontmatter のペアにも
 * 両方を渡して判定するので、「訳すときには教えず、あとで用語が違うと咎める」形に
 * なっていた。同じものが届くことをここで固定する。
 */

import { strict as assert } from "node:assert";
import { LangTerm, TermEntry } from "../../../../commands/term/term-entry";
import { buildFrontmatterContext } from "../../../../commands/trans/frontmatter-context";

const terms = [
	TermEntry.create("クモノート", {
		ja: LangTerm.create("クモノート"),
		en: LangTerm.create("Kumo Note"),
	}),
	TermEntry.create("共有", {
		ja: LangTerm.create("共有"),
		en: LangTerm.create("sharing"),
	}),
];

suite("frontmatter を訳すときの文脈", () => {
	test("値に出てくる用語が文脈に入る", () => {
		const context = buildFrontmatterContext("クモノート ドキュメント", terms, "ja", "en");

		assert.ok(context.terms, "用語集が文脈に入っていること");
		const parsed = JSON.parse(context.terms);
		assert.strictEqual(parsed.length, 1);
		assert.strictEqual(parsed[0].term, "クモノート");
		assert.strictEqual(parsed[0].translation, "Kumo Note");
	});

	test("値に出てこない用語は入らない", () => {
		const context = buildFrontmatterContext("料金と支払い", terms, "ja", "en");

		assert.strictEqual(context.terms, undefined);
	});

	test("用語集が空なら文脈にも入らない", () => {
		const context = buildFrontmatterContext("クモノート ドキュメント", [], "ja", "en");

		assert.strictEqual(context.terms, undefined);
	});

	test("バッククォートを含む値でも拾う（frontmatter の値は Markdown ではない）", () => {
		// 本文なら `...` はインラインコードとして照合から外れるが、
		// frontmatter の値は1つの文字列なので、その規則を当てる意味がない。
		const context = buildFrontmatterContext("`クモノート` の使い方", terms, "ja", "en");

		assert.ok(context.terms, "インラインコードの記号があっても用語を拾うこと");
		assert.strictEqual(JSON.parse(context.terms)[0].term, "クモノート");
	});

	test("複数の用語が当たれば全部入る", () => {
		const context = buildFrontmatterContext("クモノートの共有について", terms, "ja", "en");

		assert.ok(context.terms);
		assert.strictEqual(JSON.parse(context.terms).length, 2);
	});

	test("前回の訳文は改訂のときだけ渡され、そのまま文脈に入る", () => {
		const withPrevious = buildFrontmatterContext("クモノート ドキュメント", terms, "ja", "en", "Kumo Note Docs");
		assert.strictEqual(withPrevious.previousTranslation, "Kumo Note Docs");

		const withoutPrevious = buildFrontmatterContext("クモノート ドキュメント", terms, "ja", "en");
		assert.strictEqual(withoutPrevious.previousTranslation, undefined);
	});

	test("周辺のユニットは渡さない（frontmatter に前後の章は無い）", () => {
		const context = buildFrontmatterContext("クモノート ドキュメント", terms, "ja", "en");

		assert.deepStrictEqual(context.previousTexts, []);
		assert.deepStrictEqual(context.nextTexts, []);
	});
});
