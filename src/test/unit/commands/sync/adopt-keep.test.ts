import * as assert from "node:assert";
import { syncMarkerPair } from "../../../../commands/sync/marker-sync";
import { SectionMatcher } from "../../../../commands/sync/section-matcher";
import { calculateHash } from "../../../../core/hash/hash-calculator";
import { MdaitMarker } from "../../../../core/markdown/mdait-marker";
import { MdaitUnit } from "../../../../core/markdown/mdait-unit";

function unitOf(content: string, marker: MdaitMarker | null = null, title = ""): MdaitUnit {
	const m = marker ?? new MdaitMarker(calculateHash(content));
	return new MdaitUnit(m, title, 2, content, 0, 10);
}

suite("adopt（既存対訳の採用）", () => {
	suite("syncMarkerPair の adoptTarget オプション", () => {
		test("from新規確立＋needなし＋adopt → need:review が付き既訳が採用される", () => {
			// マーカーなし既訳のsync: ensureMdaitMarkerHashによりhashのみのマーカーが付いた状態
			const tgtMarker = new MdaitMarker("tgt123");
			const result = syncMarkerPair("src123", "tgt123", null, tgtMarker, {
				adoptTarget: true,
			});
			assert.strictEqual(result.targetMarker.from, "src123");
			assert.strictEqual(result.targetMarker.need, "review");
		});

		test("adoptなしの同条件では need:translate（従来動作の維持）", () => {
			const tgtMarker = new MdaitMarker("tgt123");
			const result = syncMarkerPair("src123", "tgt123", null, tgtMarker);
			assert.strictEqual(result.targetMarker.need, "translate");
		});

		test("adoptでも新規ターゲット（マーカーなし）は need:translate", () => {
			const result = syncMarkerPair("src123", "src123", null, null, {
				adoptTarget: true,
			});
			assert.strictEqual(result.targetMarker.need, "translate");
		});

		test("adoptでも既にfrom確立済みのユニットには影響しない", () => {
			const tgtMarker = new MdaitMarker("tgt123", "src123", null);
			const result = syncMarkerPair("src123", "tgt123", new MdaitMarker("src123"), tgtMarker, {
				adoptTarget: true,
			});
			assert.strictEqual(result.targetMarker.need, null);
		});

		test("adopt済みユニットの2回目のsyncは無変更（冪等性）", () => {
			const tgtMarker = new MdaitMarker("tgt123");
			const first = syncMarkerPair("src123", "tgt123", null, tgtMarker, {
				adoptTarget: true,
			});
			// 2回目: from確立済み・need:review
			const second = syncMarkerPair("src123", "tgt123", first.sourceMarker, first.targetMarker, {
				adoptTarget: true,
			});
			assert.strictEqual(second.targetMarker.from, "src123");
			assert.strictEqual(second.targetMarker.need, "review");
			assert.strictEqual(second.targetMarker.hash, "tgt123");
		});

		test("adoptで採用されたユニットはtransの対象にならない（needsTranslation=false）", () => {
			const tgtMarker = new MdaitMarker("tgt123");
			const result = syncMarkerPair("src123", "tgt123", null, tgtMarker, {
				adoptTarget: true,
			});
			assert.strictEqual(result.targetMarker.needsTranslation(), false);
		});

		test("adopt採用後にソースが変更されたら通常のreviseフローに乗る", () => {
			const tgtMarker = new MdaitMarker("tgt123", "src123", null); // レビュー承認済み（need除去済み）
			const result = syncMarkerPair("src456", "tgt123", new MdaitMarker("src456"), tgtMarker);
			assert.strictEqual(result.targetMarker.need, "revise@src123");
		});
	});
});

suite("orphanTargetPolicy（孤立ターゲットの処理）", () => {
	function orphanMatchResult(marker: MdaitMarker | null) {
		const target = unitOf("## Extra section\n\nEnglish only content.", marker);
		return [{ source: null, target }];
	}

	test("delete: 孤立ターゲットは削除される", () => {
		const matcher = new SectionMatcher();
		const result = matcher.createSyncedTargets(
			orphanMatchResult(new MdaitMarker("abc", "gone-source")),
			"delete",
		);
		assert.strictEqual(result.units.length, 0);
		assert.strictEqual(result.orphanDeleted, 1);
	});

	test("verify: 孤立ターゲットに need:verify-deletion が付与され保持される", () => {
		const matcher = new SectionMatcher();
		const result = matcher.createSyncedTargets(
			orphanMatchResult(new MdaitMarker("abc", "gone-source")),
			"verify",
		);
		assert.strictEqual(result.units.length, 1);
		assert.strictEqual(result.units[0].marker?.need, "verify-deletion");
		assert.strictEqual(result.orphanVerified, 1);
	});

	test("keep: 孤立ターゲットに need:keep が付与され、fromが除去される（独自ユニット化）", () => {
		const matcher = new SectionMatcher();
		const result = matcher.createSyncedTargets(
			orphanMatchResult(new MdaitMarker("abc", "gone-source")),
			"keep",
		);
		assert.strictEqual(result.units.length, 1);
		assert.strictEqual(result.units[0].marker?.need, "keep");
		assert.strictEqual(result.units[0].marker?.from, null);
		assert.strictEqual(result.orphanKept, 1);
	});

	test("既存の need:keep ユニットはポリシーがdeleteでも保持される（恒久保持の保証）", () => {
		const matcher = new SectionMatcher();
		const result = matcher.createSyncedTargets(
			orphanMatchResult(new MdaitMarker("abc", null, "keep")),
			"delete",
		);
		assert.strictEqual(result.units.length, 1);
		assert.strictEqual(result.units[0].marker?.need, "keep");
		assert.strictEqual(result.orphanKept, 1);
	});

	test("keepポリシーの2回目のsyncでもユニットが不変（冪等性）", () => {
		const matcher = new SectionMatcher();
		const first = matcher.createSyncedTargets(
			orphanMatchResult(new MdaitMarker("abc", "gone-source")),
			"keep",
		);
		const keptUnit = first.units[0];
		const second = matcher.createSyncedTargets([{ source: null, target: keptUnit }], "keep");
		assert.strictEqual(second.units.length, 1);
		assert.strictEqual(second.units[0].marker?.need, "keep");
		assert.strictEqual(second.units[0].content, keptUnit.content);
	});
});

suite("SectionMatcher と need:keep の相互作用", () => {
	test("need:keep のターゲットはソースと誤対応せずパススルーされる", () => {
		// ソース側に新規ユニット、ターゲット側にkeepユニットのみ
		const source = unitOf("## 新しいセクション\n\n日本語本文。");
		const keepTarget = unitOf(
			"## English-only section\n\nKept content.",
			new MdaitMarker("keep1", null, "keep"),
		);
		const matcher = new SectionMatcher();
		const matchResult = matcher.match([source], [keepTarget]);

		// keepユニットがsourceとペアにならないこと
		const keepPair = matchResult.find((p) => p.target === keepTarget);
		assert.ok(keepPair);
		assert.strictEqual(keepPair.source, null);

		// sourceは新規追加として扱われること
		const sourcePair = matchResult.find((p) => p.source === source);
		assert.ok(sourcePair);
		assert.strictEqual(sourcePair.target, null);
	});

	test("keepユニットと通常ユニットが混在しても対応付けが崩れない", () => {
		const src1 = unitOf("## A\n\n本文A", new MdaitMarker("srcA"));
		const src2 = unitOf("## B\n\n本文B", new MdaitMarker("srcB"));
		const tgtA = unitOf("## A(en)\n\nContent A", new MdaitMarker("tgtA", "srcA"));
		const keep = unitOf("## Extra\n\nKept", new MdaitMarker("keep1", null, "keep"));
		const tgtB = unitOf("## B(en)\n\nContent B", new MdaitMarker("tgtB", "srcB"));

		const matcher = new SectionMatcher();
		const matchResult = matcher.match([src1, src2], [tgtA, keep, tgtB]);

		assert.strictEqual(matchResult.find((p) => p.source === src1)?.target, tgtA);
		assert.strictEqual(matchResult.find((p) => p.source === src2)?.target, tgtB);
		const keepPair = matchResult.find((p) => p.target === keep);
		assert.ok(keepPair);
		assert.strictEqual(keepPair.source, null);
	});
});
