/**
 * @file align-result.ts
 * @description
 *   AIアライン（差分審査型）の結果型と純関数。
 *   ユニットスケルトン生成・本文ダイジェスト・修正提案のバリデーション
 *   （範囲・単射性・locked除外・confidence閾値）・matchResult 再配線を担う。
 *   VS Code API 非依存（単体テストの中心）。ADR-260705-02。
 * @module commands/ai-sync/align-result
 */

import type { MdaitUnit } from "../../core/markdown/mdait-unit";
import type { MatchResult, SectionPair } from "../sync/section-matcher";

/** AI に渡す1ユニットのスケルトン */
export interface UnitSkeleton {
	/** 配列位置（source.units / target.units 内のインデックス） */
	index: number;
	/** 見出しレベル（1=h1, ... 0=本文のみ） */
	level: number;
	/** 見出し */
	title: string;
	/** コード除去済み本文ダイジェスト（先頭 ~80 字） */
	digest: string;
	/** 本文の文字数 */
	length: number;
}

/** 位置ベース対応表の1エントリ */
export interface CorrespondenceEntry {
	sourceIndex: number;
	targetIndex: number;
	/** Phase 1（from アンカー）由来で審査対象外なら true */
	locked: boolean;
}

/** AI が要求する追加本文の参照（二段トリアージ） */
export interface NeedBodyRef {
	side: "source" | "target";
	index: number;
}

/** AI の修正提案 */
export interface AlignCorrection {
	sourceIndex: number;
	targetIndex: number;
	confidence: number;
}

/** AI 応答のパース済み表現（判別共用体） */
export type ParsedAlignResponse =
	| { kind: "ok" }
	| { kind: "corrections"; corrections: AlignCorrection[] }
	| { kind: "needBodies"; refs: NeedBodyRef[] };

/** 修正提案バリデーションのコンテキスト */
export interface CorrectionValidationContext {
	sourceCount: number;
	targetCount: number;
	/** 審査対象外（Phase 1）のソースインデックス */
	lockedSourceIndexes: ReadonlySet<number>;
	/** 審査対象外（Phase 1・need:keep）のターゲットインデックス */
	lockedTargetIndexes: ReadonlySet<number>;
	/** 受理する confidence の下限（0..1） */
	minConfidence: number;
}

/** 棄却された修正提案とその理由 */
export interface RejectedCorrection {
	correction: AlignCorrection;
	reason: string;
}

/** 修正提案バリデーションの結果 */
export interface CorrectionValidationResult {
	accepted: AlignCorrection[];
	rejected: RejectedCorrection[];
}

/** 1ファイル分のアライン結果サマリ */
export interface AlignSummary {
	/** 審査対象（位置ベースの both-present・非locked）ペア数 */
	candidatePairs: number;
	/** AI が提案した修正数（生） */
	proposed: number;
	/** バリデーションを通過し適用した修正数 */
	accepted: number;
	/** 棄却した修正数 */
	rejected: number;
	/** 使用したトリアージラウンド数 */
	rounds: number;
	/** 位置ベースへフォールバックしたか（AI応答不正・上限超過・スキップ） */
	fallback: boolean;
	/** スキップ理由（候補なし・ユニット過多など。任意） */
	skippedReason?: string;
}

/** 空のサマリを生成する */
export function createEmptyAlignSummary(): AlignSummary {
	return {
		candidatePairs: 0,
		proposed: 0,
		accepted: 0,
		rejected: 0,
		rounds: 0,
		fallback: false,
	};
}

/**
 * ユニット本文からコードを除去したダイジェストを生成する。
 * フェンス/インラインコードを除去し、先頭見出し行を落とし、空白を畳み込んで先頭 maxLen 字を返す。
 */
export function buildBodyDigest(content: string, maxLen = 80): string {
	let text = content;
	// 先頭の見出し行を除去（title は別送のため冗長）
	text = text.replace(/^\s*#{1,6}[ \t]+[^\n]*\n?/, "");
	// フェンスコードブロック（``` / ~~~）を除去
	text = text.replace(/```[\s\S]*?```/g, " ");
	text = text.replace(/~~~[\s\S]*?~~~/g, " ");
	// インラインコードを除去
	text = text.replace(/`[^`]*`/g, " ");
	// 空白の畳み込み
	text = text.replace(/\s+/g, " ").trim();
	if (text.length <= maxLen) {
		return text;
	}
	return text.slice(0, maxLen);
}

/**
 * ユニット配列からスケルトン配列を生成する（index は配列位置）。
 */
export function buildUnitSkeletons(units: readonly MdaitUnit[], digestLen = 80): UnitSkeleton[] {
	return units.map((unit, index) => ({
		index,
		level: unit.headingLevel,
		title: unit.title,
		digest: buildBodyDigest(unit.content, digestLen),
		length: unit.content.length,
	}));
}

/**
 * matchResult から位置ベース対応表を生成する。
 * both-present ペアのみを対象とし、target が from アンカーを持つ（Phase 1）ものは locked=true。
 */
export function buildCorrespondence(
	matchResult: MatchResult,
	sourceUnits: readonly MdaitUnit[],
	targetUnits: readonly MdaitUnit[],
): CorrespondenceEntry[] {
	const entries: CorrespondenceEntry[] = [];
	for (const pair of matchResult) {
		if (!pair.source || !pair.target) {
			continue;
		}
		const sourceIndex = sourceUnits.indexOf(pair.source);
		const targetIndex = targetUnits.indexOf(pair.target);
		if (sourceIndex < 0 || targetIndex < 0) {
			continue;
		}
		entries.push({
			sourceIndex,
			targetIndex,
			locked: !!pair.target.marker?.from,
		});
	}
	return entries;
}

function isInteger(value: number): boolean {
	return Number.isInteger(value);
}

/**
 * 修正提案を1件ずつ独立にバリデーションする。
 * 範囲外・locked に触れる・単射性違反・confidence 不足の提案のみを棄却し、
 * 残りを受理する（不正な1件がファイル全体を止めない）。
 */
export function validateCorrections(
	corrections: readonly AlignCorrection[],
	ctx: CorrectionValidationContext,
): CorrectionValidationResult {
	const accepted: AlignCorrection[] = [];
	const rejected: RejectedCorrection[] = [];
	const claimedSources = new Set<number>();
	const claimedTargets = new Set<number>();

	for (const correction of corrections) {
		const { sourceIndex, targetIndex, confidence } = correction;

		if (!isInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= ctx.sourceCount) {
			rejected.push({ correction, reason: `sourceIndex out of range: ${sourceIndex}` });
			continue;
		}
		if (!isInteger(targetIndex) || targetIndex < 0 || targetIndex >= ctx.targetCount) {
			rejected.push({ correction, reason: `targetIndex out of range: ${targetIndex}` });
			continue;
		}
		if (typeof confidence !== "number" || Number.isNaN(confidence)) {
			rejected.push({ correction, reason: "confidence is not a number" });
			continue;
		}
		if (confidence < ctx.minConfidence) {
			rejected.push({ correction, reason: `confidence below threshold: ${confidence}` });
			continue;
		}
		if (ctx.lockedSourceIndexes.has(sourceIndex)) {
			rejected.push({ correction, reason: `sourceIndex is locked (from-anchored): ${sourceIndex}` });
			continue;
		}
		if (ctx.lockedTargetIndexes.has(targetIndex)) {
			rejected.push({ correction, reason: `targetIndex is locked: ${targetIndex}` });
			continue;
		}
		if (claimedSources.has(sourceIndex)) {
			rejected.push({ correction, reason: `sourceIndex already claimed: ${sourceIndex}` });
			continue;
		}
		if (claimedTargets.has(targetIndex)) {
			rejected.push({ correction, reason: `targetIndex already claimed: ${targetIndex}` });
			continue;
		}

		claimedSources.add(sourceIndex);
		claimedTargets.add(targetIndex);
		accepted.push(correction);
	}

	return { accepted, rejected };
}

/**
 * match() と同じ順序規約でペアを並べ替える。
 * source を持つペアを source 位置順、その後に孤立ターゲットを target 位置順で並べる。
 */
function orderPairs(
	pairs: SectionPair[],
	sourceUnits: readonly MdaitUnit[],
	targetUnits: readonly MdaitUnit[],
): MatchResult {
	const ordered: SectionPair[] = [];
	for (const source of sourceUnits) {
		const pair = pairs.find((p) => p.source === source);
		if (pair) {
			ordered.push(pair);
		}
	}
	for (const target of targetUnits) {
		const pair = pairs.find((p) => !p.source && p.target === target);
		if (pair) {
			ordered.push(pair);
		}
	}
	return ordered;
}

/**
 * 受理済み修正提案を matchResult に適用して再配線する。
 *
 * - 受理修正 `{sourceIndex, targetIndex}` で `source[si] ↔ target[ti]` を再ペア化する
 * - 修正に消費されなかった元ペアはそのまま維持する
 * - 消費により片側を失ったユニットは未対応化する（source→新規 `{source,null}`、target→孤立 `{null,target}`）
 * - 受理修正が空なら matchResult をそのまま返す（＝位置ベースへのフォールバック＝恒等）
 */
export function applyCorrections(
	matchResult: MatchResult,
	accepted: readonly AlignCorrection[],
	sourceUnits: readonly MdaitUnit[],
	targetUnits: readonly MdaitUnit[],
): MatchResult {
	if (accepted.length === 0) {
		return matchResult;
	}

	const consumedSources = new Set(accepted.map((c) => c.sourceIndex));
	const consumedTargets = new Set(accepted.map((c) => c.targetIndex));

	const rebuilt: SectionPair[] = [];
	for (const pair of matchResult) {
		const sIdx = pair.source ? sourceUnits.indexOf(pair.source) : -1;
		const tIdx = pair.target ? targetUnits.indexOf(pair.target) : -1;
		const sConsumed = sIdx >= 0 && consumedSources.has(sIdx);
		const tConsumed = tIdx >= 0 && consumedTargets.has(tIdx);

		if (!sConsumed && !tConsumed) {
			// 消費に触れないペアはそのまま維持（both / source-only / target-only）
			rebuilt.push(pair);
			continue;
		}
		// 片側だけ消費された場合、残った側を孤立ペアとして復活させる
		if (pair.source && !sConsumed) {
			rebuilt.push({ source: pair.source, target: null });
		}
		if (pair.target && !tConsumed) {
			rebuilt.push({ source: null, target: pair.target });
		}
	}

	// 受理修正の新ペアを追加
	for (const c of accepted) {
		rebuilt.push({ source: sourceUnits[c.sourceIndex], target: targetUnits[c.targetIndex] });
	}

	return orderPairs(rebuilt, sourceUnits, targetUnits);
}
