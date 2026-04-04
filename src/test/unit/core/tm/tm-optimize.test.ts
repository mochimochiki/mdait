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
});
