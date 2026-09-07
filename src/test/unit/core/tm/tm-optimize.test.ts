import * as assert from "node:assert";
import { recomputeTmWeights } from "../../../../core/tm/tm-optimize";
import type { TmEntry } from "../../../../core/tm/types";

function entry(tuid: string, primary: string): TmEntry {
	return {
		tuid,
		primary,
		weight: 1,
		variants: new Map([
			["en", { text: primary }],
			["ja", { text: `${primary}-ja` }],
		]),
	};
}

suite("recomputeTmWeights", () => {
	test("corpusPresence は現行primary完全一致で 1/0 になる", () => {
		const entries = [entry("a", "Alpha sentence."), entry("b", "Beta sentence.")];
		const weights = recomputeTmWeights(entries, ["Alpha sentence."], "en");
		assert.strictEqual(weights.get("a"), 1);
		assert.ok((weights.get("b") ?? 1) < 0.3);
	});

	test("retrievalUsefulness が上位出現回数に応じて weight 差を作る", () => {
		const entries = [entry("a", "Install package now."), entry("b", "Random unrelated sentence.")];
		const weights = recomputeTmWeights(entries, ["Install package now!", "Install package now."], "en");
		assert.ok((weights.get("a") ?? 0) > (weights.get("b") ?? 0));
	});

	test("同一入力なら冪等に同じ結果を返す", () => {
		const entries = [entry("a", "Alpha"), entry("b", "Beta")];
		const queries = ["Alpha", "Beta", "Gamma"];
		const weights1 = recomputeTmWeights(entries, queries, "en");
		const weights2 = recomputeTmWeights(entries, queries, "en");
		assert.deepStrictEqual([...weights1.entries()], [...weights2.entries()]);
	});

	test("計算した重みを書き戻してから計算し直しても、同じ値になる", () => {
		// 実測で見つかった欠陥の回帰固定: 順位付けが現在の重みで補正されていたため、
		// 「重みを入力にして重みを出す」形になっていた。TM 登録の後段でこれが毎回走るので、
		// 中身が同じでも 2 回目まで translations.tmx が差分になっていた（3 回目で落ち着く）。
		const entries = [
			entry("a", "Install the package now."),
			entry("b", "Install the package later."),
			entry("c", "Install the package soon."),
			entry("d", "Update the package now."),
			entry("e", "Remove the package now."),
			entry("f", "Configure the package now."),
			entry("g", "Something entirely different."),
			entry("h", "Another unrelated sentence here."),
		];
		const queries = ["Install the package now.", "Update the package soon.", "Configure the package later."];

		const first = recomputeTmWeights(entries, queries, "en");
		for (const item of entries) item.weight = first.get(item.tuid) ?? 1;
		const second = recomputeTmWeights(entries, queries, "en");

		assert.deepStrictEqual([...second.entries()], [...first.entries()]);
	});
});
