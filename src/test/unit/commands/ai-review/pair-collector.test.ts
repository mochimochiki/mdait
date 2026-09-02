import * as assert from "node:assert";
import {
	FRONTMATTER_PAIR_TITLE,
	collectFrontmatterReviewPair,
	collectReviewPairs,
} from "../../../../commands/ai-review/pair-collector";
import { FrontMatter } from "../../../../core/markdown/front-matter";
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
		const isolateTarget = unitOf("## Extra\n\nKept", new MdaitMarker("iso1", null, "isolate"), "Extra");

		const pairs = collectReviewPairs([srcA, srcB], [reviewTarget, cleanTarget, translateTarget, isolateTarget]);

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

suite("collectReviewPairs（audit モードの対象拡張）", () => {
	test("audit では確定済みペア（from あり・need なし）も need:review も列挙される", () => {
		const srcA = unitOf("## A\n\n本文A", new MdaitMarker("srcA"), "A");
		const srcB = unitOf("## B\n\n本文B", new MdaitMarker("srcB"), "B");
		const reviewTarget = unitOf("## A(en)\n\nContent A", new MdaitMarker("tgtA", "srcA", "review"), "A(en)");
		const settledTarget = unitOf("## B(en)\n\nContent B", new MdaitMarker("tgtB", "srcB", null), "B(en)");

		const pending = collectReviewPairs([srcA, srcB], [reviewTarget, settledTarget], "pending");
		assert.strictEqual(pending.length, 1, "pending は need:review のみ");

		const audit = collectReviewPairs([srcA, srcB], [reviewTarget, settledTarget], "audit");
		assert.strictEqual(audit.length, 2, "audit は確定済みペアも含む");
		assert.strictEqual(audit[0].targetUnit, reviewTarget);
		assert.strictEqual(audit[1].targetUnit, settledTarget);
		assert.strictEqual(audit[1].sourceUnit, srcB);
	});

	test("audit でも from が無いユニットは対象外（ペアリング検証は from リンクが前提）", () => {
		const src = unitOf("## A\n\n本文", new MdaitMarker("srcA"), "A");
		const noFrom = unitOf("## Extra(en)\n\nLocal", new MdaitMarker("orphanEn", null, null), "Extra");
		assert.deepStrictEqual(collectReviewPairs([src], [noFrom], "audit"), []);
	});

	test("audit でも in-flight な need 状態（translate/revise/isolate/verify-deletion）は対象外", () => {
		const src = unitOf("## A\n\n本文", new MdaitMarker("srcA"), "A");
		const translate = unitOf("## T\n\n", new MdaitMarker("t1", "srcA", "translate"), "T");
		const revise = unitOf("## R\n\nx", new MdaitMarker("r1", "srcA", "revise@old"), "R");
		const isolate = unitOf("## I\n\nx", new MdaitMarker("i1", "srcA", "isolate"), "I");
		const verifyDeletion = unitOf("## V\n\nx", new MdaitMarker("v1", "srcA", "verify-deletion"), "V");
		assert.deepStrictEqual(collectReviewPairs([src], [translate, revise, isolate, verifyDeletion], "audit"), []);
	});
});

/** frontmatter を YAML から組み立てる（実ファイルと同じ経路を通す） */
function frontMatterOf(yaml: string): FrontMatter | undefined {
	return FrontMatter.parse(`---\n${yaml}\n---\n\n本文\n`).frontMatter;
}

const KEYS = ["title", "description"];

suite("collectFrontmatterReviewPair（frontmatter の確認待ちも AI 翻訳レビューにかける）", () => {
	const source = frontMatterOf("title: 日本語テスト2\nmdait:\n  front: 'srcF'");

	test("from と need:review を持つ frontmatter が1ペアとして列挙される", () => {
		const target = frontMatterOf("title: English Test 2\nmdait:\n  front: 'tgtF from:srcF need:review'");

		const pair = collectFrontmatterReviewPair(source, target, KEYS);

		assert.ok(pair);
		assert.strictEqual(pair.kind, "frontmatter");
		assert.strictEqual(pair.targetUnit.title, FRONTMATTER_PAIR_TITLE);
		assert.strictEqual(pair.targetUnit.marker.hash, "tgtF");
		assert.strictEqual(pair.sourceUnit?.marker.hash, "srcF");
	});

	test("判定にかけるのは翻訳対象キーの値だけで、key: value の行に組み直される", () => {
		const target = frontMatterOf(
			"title: English Test 2\nweight: 20\nmdait:\n  front: 'tgtF from:srcF need:review'",
		);

		const pair = collectFrontmatterReviewPair(source, target, KEYS);

		// weight は訳す対象ではないので渡さない（差を「訳し漏れ」と読まれないため）。
		// description は値が無いので行ごと出さない
		assert.strictEqual(pair?.targetUnit.content, "title: English Test 2");
		assert.strictEqual(pair?.sourceUnit?.content, "title: 日本語テスト2");
	});

	test("確認待ちでない frontmatter は対象にならない（pending）", () => {
		const settled = frontMatterOf("title: English Test 2\nmdait:\n  front: 'tgtF from:srcF'");
		const translate = frontMatterOf("title: 日本語テスト2\nmdait:\n  front: 'tgtF from:srcF need:translate'");

		assert.strictEqual(collectFrontmatterReviewPair(source, settled, KEYS), null);
		assert.strictEqual(collectFrontmatterReviewPair(source, translate, KEYS), null);
	});

	test("audit では確定済みの frontmatter も監査対象になる", () => {
		const settled = frontMatterOf("title: English Test 2\nmdait:\n  front: 'tgtF from:srcF'");

		assert.ok(collectFrontmatterReviewPair(source, settled, KEYS, "audit"));
	});

	test("紐が切れていれば原文側は解決されない（skipped 扱いにする）", () => {
		const target = frontMatterOf("title: English Test 2\nmdait:\n  front: 'tgtF from:other need:review'");

		const pair = collectFrontmatterReviewPair(source, target, KEYS);

		assert.ok(pair);
		assert.strictEqual(pair.sourceUnit, null);
	});

	test("翻訳対象キーが未設定なら何も列挙しない", () => {
		const target = frontMatterOf("title: English Test 2\nmdait:\n  front: 'tgtF from:srcF need:review'");

		assert.strictEqual(collectFrontmatterReviewPair(source, target, []), null);
	});

	test("翻訳対象キーに値が無い frontmatter は列挙しない（比べるものが無い）", () => {
		const target = frontMatterOf("weight: 20\nmdait:\n  front: 'tgtF from:srcF need:review'");

		assert.strictEqual(collectFrontmatterReviewPair(source, target, KEYS), null);
	});
});
