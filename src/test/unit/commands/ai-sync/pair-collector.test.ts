import * as assert from "node:assert";
import { collectReviewPairs } from "../../../../commands/ai-sync/pair-collector";
import { MdaitMarker } from "../../../../core/markdown/mdait-marker";
import { MdaitUnit } from "../../../../core/markdown/mdait-unit";

function unitOf(content: string, marker: MdaitMarker | null, title = ""): MdaitUnit {
	return new MdaitUnit(marker as MdaitMarker, title, 2, content, 0, 10);
}

suite("collectReviewPairs（検証対象ペアの列挙）", () => {
	test("from と need:review を持つターゲットユニットのみが列挙される", () => {
		const srcA = unitOf("## A\n\n本文A", new MdaitMarker("srcA"), "A");
		const srcB = unitOf("## B\n\n本文B", new MdaitMarker("srcB"), "B");
		const reviewTarget = unitOf("## A(en)\n\nContent A", new MdaitMarker("tgtA", "srcA", "review"), "A(en)");
		const cleanTarget = unitOf("## B(en)\n\nContent B", new MdaitMarker("tgtB", "srcB", null), "B(en)");
		const translateTarget = unitOf("## C(en)\n\n", new MdaitMarker("tgtC", "srcC", "translate"), "C(en)");
		const keepTarget = unitOf("## Extra\n\nKept", new MdaitMarker("keep1", null, "keep"), "Extra");

		const pairs = collectReviewPairs([srcA, srcB], [reviewTarget, cleanTarget, translateTarget, keepTarget]);

		assert.strictEqual(pairs.length, 1);
		assert.strictEqual(pairs[0].targetUnit, reviewTarget);
		assert.strictEqual(pairs[0].sourceUnit, srcA);
	});

	test("need:review が無いクリーンなファイルでは空になる", () => {
		const src = unitOf("## A\n\n本文", new MdaitMarker("srcA"), "A");
		const tgt = unitOf("## A(en)\n\nContent", new MdaitMarker("tgtA", "srcA", null), "A(en)");
		assert.deepStrictEqual(collectReviewPairs([src], [tgt]), []);
	});

	test("from に対応するソースユニットが無い場合は sourceUnit が null になる", () => {
		const src = unitOf("## A\n\n本文", new MdaitMarker("srcA"), "A");
		const orphanReview = unitOf("## X(en)\n\nContent X", new MdaitMarker("tgtX", "goneSource", "review"), "X(en)");
		const pairs = collectReviewPairs([src], [orphanReview]);
		assert.strictEqual(pairs.length, 1);
		assert.strictEqual(pairs[0].sourceUnit, null);
	});

	test("from が無い need:review ユニットは対象外（ペアリング検証は from リンクが前提）", () => {
		const src = unitOf("## A\n\n本文", new MdaitMarker("srcA"), "A");
		const noFromReview = unitOf("## Y(en)\n\nContent Y", new MdaitMarker("tgtY", null, "review"), "Y(en)");
		assert.deepStrictEqual(collectReviewPairs([src], [noFromReview]), []);
	});

	test("複数の need:review ユニットがドキュメント順で列挙される", () => {
		const srcA = unitOf("## A\n\n本文A", new MdaitMarker("srcA"), "A");
		const srcB = unitOf("## B\n\n本文B", new MdaitMarker("srcB"), "B");
		const tgtA = unitOf("## A(en)\n\nContent A", new MdaitMarker("tgtA", "srcA", "review"), "A(en)");
		const tgtB = unitOf("## B(en)\n\nContent B", new MdaitMarker("tgtB", "srcB", "review"), "B(en)");
		const pairs = collectReviewPairs([srcA, srcB], [tgtA, tgtB]);
		assert.strictEqual(pairs.length, 2);
		assert.strictEqual(pairs[0].sourceUnit, srcA);
		assert.strictEqual(pairs[1].sourceUnit, srcB);
	});
});
