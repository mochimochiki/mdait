// planContentRelink（VS Code の外で動かされたファイルを内容で結び直す判定）のテスト
// 迷ったら結び直さない、を固定する

import { strict as assert } from "node:assert";
import { RELINK_MIN_COVERAGE, planContentRelink } from "../../../../core/unit-state/content-relink";

/** 読みやすさのための組み立て補助 */
function lost(path: string, ...hashes: string[]) {
	return { path, hashes: new Set(hashes) };
}
function fresh(path: string, ...hashes: string[]) {
	return { path, hashes: new Set(hashes) };
}

suite("planContentRelink（内容によるファイル再リンク）", () => {
	test("中身がそっくり移っていれば結び直すこと", () => {
		const plan = planContentRelink(
			[lost("en/guide.md", "h1", "h2", "h3")],
			[fresh("en/handbook.md", "h1", "h2", "h3")],
		);

		assert.strictEqual(plan.decisions.length, 1);
		assert.deepStrictEqual(
			{ from: plan.decisions[0].from, to: plan.decisions[0].to, matched: plan.decisions[0].matched },
			{ from: "en/guide.md", to: "en/handbook.md", matched: 3 },
		);
		assert.strictEqual(plan.decisions[0].coverageLost, 1);
		assert.strictEqual(plan.decisions[0].coverageNew, 1);
	});

	test("動かしたついでに一部を直していても、被覆率が足りていれば結び直すこと", () => {
		// 4章のうち3章がそのまま＝被覆率 0.75
		const plan = planContentRelink(
			[lost("en/guide.md", "h1", "h2", "h3", "h4")],
			[fresh("en/handbook.md", "h1", "h2", "h3", "new")],
		);

		assert.strictEqual(plan.decisions.length, 1);
		assert.ok(plan.decisions[0].coverageLost >= RELINK_MIN_COVERAGE);
	});

	test("重なりが薄ければ結び直さないこと", () => {
		const plan = planContentRelink(
			[lost("en/guide.md", "h1", "h2", "h3", "h4")],
			[fresh("en/other.md", "h1", "x2", "x3", "x4")],
		);

		assert.strictEqual(plan.decisions.length, 0, "別の文書に状態を移さない");
		assert.strictEqual(plan.rejections.length, 0, "閾値に届かない組は候補にもならない");
	});

	test("片側だけ被覆率が高くても結び直さないこと（小さい文書が大きい文書に飲まれない）", () => {
		// 旧行1件がすべて含まれている（covLost=1.0）が、いまの本文は10章ある（covNew=0.1）
		const big = Array.from({ length: 10 }, (_, i) => `h${i}`);
		const plan = planContentRelink([lost("en/part.md", "h0")], [fresh("en/whole.md", ...big)]);

		assert.strictEqual(plan.decisions.length, 0);
	});

	test("候補が2つ以上あるときは、どちらへも結び直さないこと", () => {
		// 中身が1文字も違わない訳文が2本まとめて動いた形。
		// どの行がどのファイルのものか内容から決められない
		const plan = planContentRelink(
			[lost("en/guide.md", "h1", "h2"), lost("en/twin.md", "h1", "h2")],
			[fresh("en/handbook.md", "h1", "h2"), fresh("en/notebook.md", "h1", "h2")],
		);

		assert.strictEqual(plan.decisions.length, 0, "1件も結び直さない");
		assert.strictEqual(plan.rejections.length, 4, "候補にはなったが全部見送る");
		assert.ok(
			plan.rejections.every((r) => r.reason === "ambiguous-lost" || r.reason === "ambiguous-new"),
			"見送りの理由が付いている",
		);
	});

	test("紛らわしい相手がいても、一意に決まる組だけは結び直すこと", () => {
		const plan = planContentRelink(
			[lost("en/guide.md", "a1", "a2"), lost("en/twin.md", "b1", "b2"), lost("en/clone.md", "b1", "b2")],
			[fresh("en/handbook.md", "a1", "a2"), fresh("en/notebook.md", "b1", "b2")],
		);

		assert.strictEqual(plan.decisions.length, 1);
		assert.strictEqual(plan.decisions[0].from, "en/guide.md");
		assert.strictEqual(plan.decisions[0].to, "en/handbook.md");
	});

	test("空のファイルは候補にしないこと", () => {
		assert.strictEqual(planContentRelink([lost("en/guide.md")], [fresh("en/handbook.md", "h1")]).decisions.length, 0);
		assert.strictEqual(planContentRelink([lost("en/guide.md", "h1")], [fresh("en/handbook.md")]).decisions.length, 0);
	});

	test("どちらかが空の一覧なら何もしないこと", () => {
		assert.deepStrictEqual(planContentRelink([], [fresh("en/handbook.md", "h1")]).decisions, []);
		assert.deepStrictEqual(planContentRelink([lost("en/guide.md", "h1")], []).decisions, []);
	});
});
