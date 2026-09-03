import * as assert from "node:assert";
import { MdaitMarker } from "../../../../core/markdown/mdait-marker";
import { MdaitUnit } from "../../../../core/markdown/mdait-unit";
import {
	type AlignCorrection,
	type CorrectionValidationContext,
	applyCorrections,
	buildBodyDigest,
	buildCorrespondence,
	buildUnitSkeletons,
	validateCorrections,
} from "../../../../commands/adopt/align-result";
import type { MatchResult } from "../../../../commands/sync/section-matcher";

/** テスト用ユニット生成ヘルパー */
function unit(
	hash: string,
	title: string,
	content: string,
	opts: { from?: string | null; need?: string | null; level?: number } = {},
): MdaitUnit {
	const marker = new MdaitMarker(hash, opts.from ?? null, opts.need ?? null);
	return new MdaitUnit(marker, title, opts.level ?? 2, content, 0, 0);
}

function ctx(overrides: Partial<CorrectionValidationContext> = {}): CorrectionValidationContext {
	return {
		sourceCount: 5,
		targetCount: 5,
		lockedSourceIndexes: new Set<number>(),
		lockedTargetIndexes: new Set<number>(),
		minConfidence: 0.6,
		...overrides,
	};
}

suite("buildBodyDigest（本文ダイジェスト）", () => {
	test("先頭見出し行を除去する", () => {
		const digest = buildBodyDigest("## タイトル\n\n本文の内容です。");
		assert.ok(!digest.includes("タイトル"), "見出しは除去される");
		assert.ok(digest.includes("本文の内容"), "本文は残る");
	});

	test("フェンスコードブロックを除去する", () => {
		const digest = buildBodyDigest("Hello\n```js\nconst secret = 1;\n```\nworld");
		assert.ok(!digest.includes("secret"), "コードは除去される");
		assert.ok(digest.includes("Hello") && digest.includes("world"), "前後の本文は残る");
	});

	test("インラインコードを除去する", () => {
		const digest = buildBodyDigest("run `npm test` now");
		assert.ok(!digest.includes("npm test"), "インラインコードは除去される");
	});

	test("maxLen で切り詰める", () => {
		const digest = buildBodyDigest("a".repeat(200), 80);
		assert.strictEqual(digest.length, 80);
	});

	test("空白を畳み込む", () => {
		const digest = buildBodyDigest("a\n\n   b\t c");
		assert.strictEqual(digest, "a b c");
	});
});

suite("buildUnitSkeletons（スケルトン生成）", () => {
	test("index・level・title・length を配列位置から付与する", () => {
		const units = [
			unit("h0", "Intro", "## Intro\n\nbody0", { level: 2 }),
			unit("h1", "Setup", "### Setup\n\nbody1 longer", { level: 3 }),
		];
		const skeletons = buildUnitSkeletons(units);
		assert.strictEqual(skeletons[0].index, 0);
		assert.strictEqual(skeletons[1].index, 1);
		assert.strictEqual(skeletons[0].level, 2);
		assert.strictEqual(skeletons[1].level, 3);
		assert.strictEqual(skeletons[0].title, "Intro");
		assert.strictEqual(skeletons[1].length, units[1].content.length);
	});

	test("lockedIndexes に含まれるユニットは locked=true になる", () => {
		const units = [unit("h0", "A", "## A\n\na"), unit("h1", "B", "## B\n\nb")];
		const skeletons = buildUnitSkeletons(units, new Set([1]));
		assert.strictEqual(skeletons[0].locked, false);
		assert.strictEqual(skeletons[1].locked, true);
	});
});

suite("buildCorrespondence（位置ベース対応表）", () => {
	test("both-present ペアのみを対象とし from ありは locked", () => {
		const s0 = unit("s0", "A", "a");
		const s1 = unit("s1", "B", "b");
		const t0 = unit("t0", "A", "a", { from: "s0" });
		const t1 = unit("t1", "B", "b");
		const sourceUnits = [s0, s1];
		const targetUnits = [t0, t1];
		const matchResult: MatchResult = [
			{ source: s0, target: t0 },
			{ source: s1, target: t1 },
			{ source: null, target: null } as never,
		];
		const entries = buildCorrespondence(matchResult, sourceUnits, targetUnits);
		assert.strictEqual(entries.length, 2);
		assert.deepStrictEqual(entries[0], { sourceIndex: 0, targetIndex: 0, locked: true });
		assert.deepStrictEqual(entries[1], { sourceIndex: 1, targetIndex: 1, locked: false });
	});
});

suite("validateCorrections（1件ずつ独立バリデーション）", () => {
	test("正常な提案は受理する", () => {
		const corrections: AlignCorrection[] = [{ sourceIndex: 2, targetIndex: 1, confidence: 0.9 }];
		const result = validateCorrections(corrections, ctx());
		assert.strictEqual(result.accepted.length, 1);
		assert.strictEqual(result.rejected.length, 0);
	});

	test("範囲外の index は棄却する", () => {
		const result = validateCorrections([{ sourceIndex: 9, targetIndex: 1, confidence: 0.9 }], ctx());
		assert.strictEqual(result.accepted.length, 0);
		assert.strictEqual(result.rejected.length, 1);
	});

	test("confidence 不足は棄却する", () => {
		const result = validateCorrections([{ sourceIndex: 1, targetIndex: 1, confidence: 0.3 }], ctx());
		assert.strictEqual(result.accepted.length, 0);
	});

	test("confidence が範囲外（>1）は棄却する", () => {
		const result = validateCorrections([{ sourceIndex: 1, targetIndex: 1, confidence: 1.5 }], ctx());
		assert.strictEqual(result.accepted.length, 0);
		assert.strictEqual(result.rejected.length, 1);
	});

	test("locked に触れる提案は棄却する", () => {
		const result = validateCorrections(
			[{ sourceIndex: 1, targetIndex: 1, confidence: 0.9 }],
			ctx({ lockedTargetIndexes: new Set([1]) }),
		);
		assert.strictEqual(result.accepted.length, 0);
	});

	test("単射性違反（同一 source/target の重複）は後続を棄却する", () => {
		const corrections: AlignCorrection[] = [
			{ sourceIndex: 2, targetIndex: 1, confidence: 0.9 },
			{ sourceIndex: 2, targetIndex: 3, confidence: 0.9 },
			{ sourceIndex: 4, targetIndex: 1, confidence: 0.9 },
		];
		const result = validateCorrections(corrections, ctx());
		assert.strictEqual(result.accepted.length, 1, "最初の1件のみ受理");
		assert.strictEqual(result.rejected.length, 2);
	});

	test("不正な1件だけを棄却し正常分は受理する", () => {
		const corrections: AlignCorrection[] = [
			{ sourceIndex: 1, targetIndex: 1, confidence: 0.9 },
			{ sourceIndex: 99, targetIndex: 2, confidence: 0.9 },
			{ sourceIndex: 3, targetIndex: 3, confidence: 0.9 },
		];
		const result = validateCorrections(corrections, ctx());
		assert.strictEqual(result.accepted.length, 2);
		assert.strictEqual(result.rejected.length, 1);
	});
});

suite("applyCorrections（matchResult 再配線）", () => {
	test("受理修正が空なら matchResult をそのまま返す（フォールバック＝恒等）", () => {
		const s0 = unit("s0", "A", "a");
		const t0 = unit("t0", "A", "a");
		const matchResult: MatchResult = [{ source: s0, target: t0 }];
		const result = applyCorrections(matchResult, [], [s0], [t0]);
		assert.strictEqual(result, matchResult, "同一参照を返す");
	});

	test("中間欠落シフト（#2）を再配線する", () => {
		// source s0,s1,s2 / target t0,t1（s1 が訳側に欠落）。位置ベースは s0-t0, s1-t1(誤), s2-null
		const s0 = unit("s0", "A", "a");
		const s1 = unit("s1", "B", "b");
		const s2 = unit("s2", "C", "c");
		const t0 = unit("t0", "A", "a");
		const t1 = unit("t1", "C", "c");
		const sourceUnits = [s0, s1, s2];
		const targetUnits = [t0, t1];
		const matchResult: MatchResult = [
			{ source: s0, target: t0 },
			{ source: s1, target: t1 },
			{ source: s2, target: null },
		];
		// AI: s2 を t1 に再ペア化
		const accepted: AlignCorrection[] = [{ sourceIndex: 2, targetIndex: 1, confidence: 0.92 }];
		const result = applyCorrections(matchResult, accepted, sourceUnits, targetUnits);
		// 期待: s0-t0, s1-null(新規), s2-t1（source順）
		assert.strictEqual(result.length, 3);
		assert.deepStrictEqual(
			result.map((p) => [p.source?.marker.hash ?? null, p.target?.marker.hash ?? null]),
			[
				["s0", "t0"],
				["s1", null],
				["s2", "t1"],
			],
		);
	});

	test("独自セクション（#3）は孤立ターゲットとして残す", () => {
		// source s0,s1 / target t0,t1,t2（t1 が訳側独自）。位置ベース s0-t0, s1-t1(誤), t2 孤立
		const s0 = unit("s0", "A", "a");
		const s1 = unit("s1", "B", "b");
		const t0 = unit("t0", "A", "a");
		const t1 = unit("t1", "X", "x");
		const t2 = unit("t2", "B", "b");
		const sourceUnits = [s0, s1];
		const targetUnits = [t0, t1, t2];
		const matchResult: MatchResult = [
			{ source: s0, target: t0 },
			{ source: s1, target: t1 },
			{ source: null, target: t2 },
		];
		// AI: s1 を t2 に再ペア化（t1 は独自セクション＝孤立へ）
		const accepted: AlignCorrection[] = [{ sourceIndex: 1, targetIndex: 2, confidence: 0.9 }];
		const result = applyCorrections(matchResult, accepted, sourceUnits, targetUnits);
		assert.deepStrictEqual(
			result.map((p) => [p.source?.marker.hash ?? null, p.target?.marker.hash ?? null]),
			[
				["s0", "t0"],
				["s1", "t2"],
				[null, "t1"],
			],
		);
	});
});
