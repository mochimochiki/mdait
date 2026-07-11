import * as assert from "node:assert";
import { alignMatchResult } from "../../../../commands/ai-sync/align-core";
import type {
	SectionAligner,
	SectionAlignRequest,
	SectionAlignResult,
} from "../../../../commands/ai-sync/section-aligner";
import { MdaitMarker } from "../../../../core/markdown/mdait-marker";
import { MdaitUnit } from "../../../../core/markdown/mdait-unit";
import type { Configuration } from "../../../../infra/config/configuration";
import { SectionMatcher } from "../../../../commands/sync/section-matcher";

function unit(
	hash: string,
	title: string,
	content: string,
	opts: { from?: string | null; need?: string | null } = {},
): MdaitUnit {
	return new MdaitUnit(new MdaitMarker(hash, opts.from ?? null, opts.need ?? null), title, 2, content, 0, 0);
}

/** align 結果を固定で返すスタブ aligner */
function stubAligner(result: SectionAlignResult, onCall?: () => void): SectionAligner {
	return {
		align: async () => {
			onCall?.();
			return result;
		},
	} as unknown as SectionAligner;
}

/** 呼ばれたら失敗させる aligner（no-op 検証用） */
function throwingAligner(): SectionAligner {
	return {
		align: async () => {
			throw new Error("aligner must not be called");
		},
	} as unknown as SectionAligner;
}

function fakeConfig(overrides: Partial<{ maxUnitsPerRun: number }> = {}): Configuration {
	return {
		trans: {
			maxUnitsPerRun: overrides.maxUnitsPerRun ?? 300,
		},
	} as unknown as Configuration;
}

const langs = { sourceLang: "ja", targetLang: "en" };

suite("alignMatchResult（アライン適用のコア）", () => {
	test("全ペアが from 済みなら候補0で no-op（冪等・aligner を呼ばない）", async () => {
		const s0 = unit("s0", "A", "a");
		const s1 = unit("s1", "B", "b");
		const t0 = unit("t0", "A", "a", { from: "s0" });
		const t1 = unit("t1", "B", "b", { from: "s1" });
		const matcher = new SectionMatcher();
		const matchResult = matcher.match([s0, s1], [t0, t1]);
		const result = await alignMatchResult([s0, s1], [t0, t1], matchResult, throwingAligner(), fakeConfig(), langs);
		assert.strictEqual(result.summary.candidatePairs, 0);
		assert.strictEqual(result.summary.accepted, 0);
		assert.strictEqual(result.matchResult, matchResult, "matchResult は不変");
	});

	test("aligner が fallback を返したら位置ベースのまま", async () => {
		const s0 = unit("s0", "A", "a");
		const s1 = unit("s1", "B", "b");
		const t0 = unit("t0", "A", "a");
		const t1 = unit("t1", "B", "b");
		const matcher = new SectionMatcher();
		const matchResult = matcher.match([s0, s1], [t0, t1]);
		const aligner = stubAligner({ corrections: [], fallback: true, rounds: 1 });
		const result = await alignMatchResult([s0, s1], [t0, t1], matchResult, aligner, fakeConfig(), langs);
		assert.strictEqual(result.summary.fallback, true);
		assert.strictEqual(result.summary.accepted, 0);
		assert.strictEqual(result.matchResult, matchResult);
	});

	test("修正提案を検証して適用する（中間欠落シフト）", async () => {
		const s0 = unit("s0", "A", "a");
		const s1 = unit("s1", "B", "b");
		const s2 = unit("s2", "C", "c");
		const t0 = unit("t0", "A", "a");
		const t1 = unit("t1", "C", "c");
		const matcher = new SectionMatcher();
		const matchResult = matcher.match([s0, s1, s2], [t0, t1]);
		// 位置ベースでは s0-t0, s1-t1(誤), s2-null。AI が s2->t1 を提案
		const aligner = stubAligner({
			corrections: [{ sourceIndex: 2, targetIndex: 1, confidence: 0.9 }],
			fallback: false,
			rounds: 1,
		});
		const result = await alignMatchResult([s0, s1, s2], [t0, t1], matchResult, aligner, fakeConfig(), langs);
		assert.strictEqual(result.summary.accepted, 1);
		assert.deepStrictEqual(
			result.matchResult.map((p) => [p.source?.marker.hash ?? null, p.target?.marker.hash ?? null]),
			[
				["s0", "t0"],
				["s1", null],
				["s2", "t1"],
			],
		);
	});

	test("低confidenceの提案は棄却され適用されない", async () => {
		const s0 = unit("s0", "A", "a");
		const s1 = unit("s1", "B", "b");
		const s2 = unit("s2", "C", "c");
		const t0 = unit("t0", "A", "a");
		const t1 = unit("t1", "C", "c");
		const matcher = new SectionMatcher();
		const matchResult = matcher.match([s0, s1, s2], [t0, t1]);
		const aligner = stubAligner({
			corrections: [{ sourceIndex: 2, targetIndex: 1, confidence: 0.2 }],
			fallback: false,
			rounds: 1,
		});
		const result = await alignMatchResult([s0, s1, s2], [t0, t1], matchResult, aligner, fakeConfig(), langs);
		assert.strictEqual(result.summary.accepted, 0);
		assert.strictEqual(result.summary.rejected, 1);
		assert.strictEqual(result.matchResult, matchResult, "適用なし＝位置ベースのまま");
	});

	test("独立ユニットの target は locked（スケルトンで審査対象外・修正提案は棄却）", async () => {
		const s0 = unit("s0", "A", "a");
		const s1 = unit("s1", "B", "b");
		// t0 はファイル永続化された from なしマーカー＝独立ユニット。t1/t2 が審査候補
		const t0 = unit("t0", "Local", "local only");
		const t1 = unit("t1", "A", "a");
		const t2 = unit("t2", "B", "b");
		const independentTargets = new Set([t0]);
		const matcher = new SectionMatcher();
		const matchResult = matcher.match([s0, s1], [t0, t1, t2], independentTargets);
		let captured: SectionAlignRequest | undefined;
		const aligner = {
			align: async (request: SectionAlignRequest): Promise<SectionAlignResult> => {
				captured = request;
				// 独立ユニット t0（index 0）への再対応付けを提案させる
				return { corrections: [{ sourceIndex: 0, targetIndex: 0, confidence: 0.9 }], fallback: false, rounds: 1 };
			},
		} as unknown as SectionAligner;
		const result = await alignMatchResult(
			[s0, s1],
			[t0, t1, t2],
			matchResult,
			aligner,
			fakeConfig(),
			langs,
			undefined,
			undefined,
			independentTargets,
		);
		assert.strictEqual(captured?.targetSkeletons[0]?.locked, true, "独立ユニットはスケルトンで locked");
		assert.strictEqual(result.summary.accepted, 0);
		assert.strictEqual(result.summary.rejected, 1, "locked target への提案は棄却される");
		assert.strictEqual(result.matchResult, matchResult, "適用なし＝位置ベースのまま");
	});

	test("need:isolate の target は locked（修正提案の対象にできない）", async () => {
		const s0 = unit("s0", "A", "a");
		const s1 = unit("s1", "B", "b");
		const t0 = unit("t0", "A", "a");
		const t1 = unit("t1", "Pivot", "keep local", { need: "isolate" });
		const matcher = new SectionMatcher();
		const matchResult = matcher.match([s0, s1], [t0, t1]);
		let captured: SectionAlignRequest | undefined;
		const aligner = {
			align: async (request: SectionAlignRequest): Promise<SectionAlignResult> => {
				captured = request;
				return { corrections: [{ sourceIndex: 1, targetIndex: 1, confidence: 0.9 }], fallback: false, rounds: 1 };
			},
		} as unknown as SectionAligner;
		const result = await alignMatchResult([s0, s1], [t0, t1], matchResult, aligner, fakeConfig(), langs);
		assert.strictEqual(captured?.targetSkeletons[1]?.locked, true, "isolate target はスケルトンで locked");
		assert.strictEqual(result.summary.accepted, 0);
		assert.strictEqual(result.summary.rejected, 1);
		assert.strictEqual(result.matchResult, matchResult);
	});

	test("need:isolate の source は locked（AI の再対応付け対象にしない）", async () => {
		const s0 = unit("s0", "A", "a");
		const s1 = unit("s1", "Local", "ja only", { need: "isolate" });
		const t0 = unit("t0", "A", "a");
		const t1 = unit("t1", "B", "b");
		const matcher = new SectionMatcher();
		const matchResult = matcher.match([s0, s1], [t0, t1]);
		let captured: SectionAlignRequest | undefined;
		const aligner = {
			align: async (request: SectionAlignRequest): Promise<SectionAlignResult> => {
				captured = request;
				// isolate source s1（index 1）と未対応 t1 のペア化を提案させる
				return { corrections: [{ sourceIndex: 1, targetIndex: 1, confidence: 0.9 }], fallback: false, rounds: 1 };
			},
		} as unknown as SectionAligner;
		const result = await alignMatchResult([s0, s1], [t0, t1], matchResult, aligner, fakeConfig(), langs);
		assert.strictEqual(captured?.sourceSkeletons[1]?.locked, true, "isolate source はスケルトンで locked");
		assert.strictEqual(result.summary.accepted, 0);
		assert.strictEqual(result.summary.rejected, 1, "locked source への提案は棄却される");
		assert.strictEqual(result.matchResult, matchResult);
	});

	test("ユニット過多はスキップして位置ベースのまま（aligner を呼ばない）", async () => {
		const s0 = unit("s0", "A", "a");
		const s1 = unit("s1", "B", "b");
		const t0 = unit("t0", "A", "a");
		const t1 = unit("t1", "B", "b");
		const matcher = new SectionMatcher();
		const matchResult = matcher.match([s0, s1], [t0, t1]);
		const result = await alignMatchResult(
			[s0, s1],
			[t0, t1],
			matchResult,
			throwingAligner(),
			fakeConfig({ maxUnitsPerRun: 1 }),
			langs,
		);
		assert.strictEqual(result.summary.fallback, true);
		assert.ok(result.summary.skippedReason?.includes("too many"));
		assert.strictEqual(result.matchResult, matchResult);
	});
});
