// FrontMatter.parse が返す値が、他の parse 結果から独立していることの回帰テスト。
//
// gray-matter は内容文字列をキーに parse 結果をキャッシュし、同じ内容には同じ data の
// 参照を返す。mdait は FrontMatter._data を破壊的に書き換えるため、キャッシュされた
// data をそのまま持つとキャッシュ側が汚染され、あとから同じ内容をパースした別の
// FrontMatter に「前回の書き換え結果」が混入していた。
//
// 実際に起きていた症状: frontmatter 付きの原文を sync → trans → 訳文ファイルを削除 →
// sync（同一内容で作り直される）→ trans とすると、frontmatter だけ翻訳されない。
// 作り直された訳文の parse がキャッシュに当たり、「翻訳済み」を示すマーカーが
// 付いた状態の data が返るため、翻訳対象と見なされなくなっていた。
// VS Code を再起動するまで直らない（プロセスが生きているあいだキャッシュが残るため）。

import { strict as assert } from "node:assert";
import { FrontMatter } from "../../../../core/markdown/front-matter";

const MD = '---\ntitle: "ガイド"\nmdait:\n  front: ca4c6cc1\n---\n\n# 見出し\n\n本文。\n';

suite("FrontMatter.parse の独立性", () => {
	test("パース結果を書き換えても、同じ内容を再パースした結果に影響しない", () => {
		const first = FrontMatter.parse(MD).frontMatter;
		assert.ok(first);
		first.set("mdait.front", "MUTATED");

		const second = FrontMatter.parse(MD).frontMatter;
		assert.ok(second);
		assert.strictEqual(second.get("mdait.front"), "ca4c6cc1", "再パース結果に前回の書き換えが混入している");
	});

	test("パース結果からキーを消しても、同じ内容を再パースすると元のキーが残っている", () => {
		const first = FrontMatter.parse(MD).frontMatter;
		assert.ok(first);
		first.delete("mdait.front");
		assert.strictEqual(first.has("mdait"), false);

		const second = FrontMatter.parse(MD).frontMatter;
		assert.ok(second);
		assert.strictEqual(second.get("mdait.front"), "ca4c6cc1", "再パース結果から前回消したキーが失われている");
	});

	test("同じ内容を2回パースすると、別々のオブジェクトが返る", () => {
		const a = FrontMatter.parse(MD).frontMatter;
		const b = FrontMatter.parse(MD).frontMatter;
		assert.ok(a);
		assert.ok(b);
		assert.notStrictEqual(a.data, b.data, "data が同じ参照を共有している");
		assert.notStrictEqual(a.data.mdait, b.data.mdait, "入れ子のオブジェクトが同じ参照を共有している");
	});

	test("先にパースした側を書き換えても、あとからパースした側の書き換えが跳ね返らない", () => {
		const a = FrontMatter.parse(MD).frontMatter;
		const b = FrontMatter.parse(MD).frontMatter;
		assert.ok(a);
		assert.ok(b);
		b.set("mdait.front", "B");
		assert.strictEqual(a.get("mdait.front"), "ca4c6cc1", "あとからの書き換えが先の結果に跳ね返っている");
	});
});
