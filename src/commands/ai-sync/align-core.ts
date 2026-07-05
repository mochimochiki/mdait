/**
 * @file align-core.ts
 * @description
 *   AIアラインのコア処理。位置ベース matchResult から審査対象（both-present・非locked）を抽出し、
 *   SectionAligner に審査させ、修正提案を1件ずつバリデーションして matchResult を再配線する。
 *   VS Code API 非依存（単体テスト可能）。sync_CoreProc から adopt+align 指定時のみ呼ばれる。
 *   ADR-260705-02 / ADR-260705-03。
 * @module commands/ai-sync/align-core
 */

import type * as vscode from "vscode";
import type { MdaitUnit } from "../../core/markdown/mdait-unit";
import type { Configuration } from "../../infra/config/configuration";
import { Logger } from "../../infra/logging/logger";
import type { MatchResult } from "../sync/section-matcher";
import {
	type AlignSummary,
	type CorrectionValidationContext,
	applyCorrections,
	buildCorrespondence,
	buildUnitSkeletons,
	createEmptyAlignSummary,
	validateCorrections,
} from "./align-result";
import type { SectionAligner } from "./section-aligner";

const logger = Logger.getInstance();

/** alignMatchResult の結果（再配線後の matchResult とサマリ） */
export interface AlignMatchResult {
	matchResult: MatchResult;
	summary: AlignSummary;
}

/**
 * 位置ベース matchResult を AI で差分審査し、修正提案を適用した matchResult を返す。
 *
 * - 審査対象は「both-present かつ target が from アンカーを持たない」位置ベースペア
 * - 既に from を持つ（Phase 1）ペア・need:keep ターゲットは審査対象外（locked）
 * - 修正提案は1件ずつバリデーション（範囲・単射性・locked・confidence）し不正のみ棄却
 * - 応答不正・上限超過・候補なし・ユニット過多は matchResult をそのまま返す（位置ベースへフォールバック）
 */
export async function alignMatchResult(
	sourceUnits: MdaitUnit[],
	targetUnits: MdaitUnit[],
	matchResult: MatchResult,
	aligner: SectionAligner,
	config: Configuration,
	langs: { sourceLang: string; targetLang: string },
	fileContext?: string,
	token?: vscode.CancellationToken,
): Promise<AlignMatchResult> {
	const summary = createEmptyAlignSummary();

	// locked（審査対象外）の抽出: from アンカー済みペア（Phase 1）と need:keep ターゲット
	const lockedSourceIndexes = new Set<number>();
	const lockedTargetIndexes = new Set<number>();
	for (let i = 0; i < targetUnits.length; i++) {
		const t = targetUnits[i];
		if (t.marker?.from || t.marker?.need === "keep") {
			lockedTargetIndexes.add(i);
		}
	}
	// 位置ベースの both-present ペアのうち、target が from を持つものは source 側も locked
	let candidatePairs = 0;
	for (const pair of matchResult) {
		if (pair.source && pair.target) {
			const sIdx = sourceUnits.indexOf(pair.source);
			if (pair.target.marker?.from) {
				if (sIdx >= 0) lockedSourceIndexes.add(sIdx);
			} else {
				candidatePairs++;
			}
		}
	}
	summary.candidatePairs = candidatePairs;

	// 候補が無ければ no-op（全ユニット from 済み＝管理済みサイト。冪等）
	if (candidatePairs === 0) {
		summary.skippedReason = "no candidate pairs";
		return { matchResult, summary };
	}

	// ユニット過多はコスト・トークン暴走防止のためスキップ（位置ベースのまま）
	const maxUnits = config.aiSync.align.maxUnitsPerFile;
	if (Math.max(sourceUnits.length, targetUnits.length) > maxUnits) {
		summary.fallback = true;
		summary.skippedReason = `too many units (> ${maxUnits})`;
		logger.info("aiSync", "Align skipped: too many units", {
			sourceUnits: sourceUnits.length,
			targetUnits: targetUnits.length,
			maxUnits,
			file: fileContext,
		});
		return { matchResult, summary };
	}

	// スケルトン・対応表を生成して AI に審査させる
	const sourceSkeletons = buildUnitSkeletons(sourceUnits);
	const targetSkeletons = buildUnitSkeletons(targetUnits);
	const correspondence = buildCorrespondence(matchResult, sourceUnits, targetUnits);

	const aiResult = await aligner.align(
		{
			sourceLang: langs.sourceLang,
			targetLang: langs.targetLang,
			sourceSkeletons,
			targetSkeletons,
			correspondence,
			sourceBodies: sourceUnits.map((u) => u.content),
			targetBodies: targetUnits.map((u) => u.content),
			fileContext,
		},
		token,
	);
	summary.rounds = aiResult.rounds;
	summary.proposed = aiResult.corrections.length;

	if (aiResult.fallback) {
		summary.fallback = true;
		return { matchResult, summary };
	}

	// 修正提案を1件ずつバリデーション（不正のみ棄却）
	const ctx: CorrectionValidationContext = {
		sourceCount: sourceUnits.length,
		targetCount: targetUnits.length,
		lockedSourceIndexes,
		lockedTargetIndexes,
		minConfidence: config.aiSync.align.minConfidence,
	};
	const validation = validateCorrections(aiResult.corrections, ctx);
	summary.accepted = validation.accepted.length;
	summary.rejected = validation.rejected.length;

	if (validation.rejected.length > 0) {
		logger.info("aiSync", "Align rejected some corrections", {
			accepted: validation.accepted.length,
			rejected: validation.rejected.map((r) => r.reason),
			file: fileContext,
		});
	}

	if (validation.accepted.length === 0) {
		// 適用可能な修正が無い＝位置ベースのまま（恒等）
		return { matchResult, summary };
	}

	const rewired = applyCorrections(matchResult, validation.accepted, sourceUnits, targetUnits);
	logger.info("aiSync", "Align applied corrections", {
		candidatePairs,
		accepted: validation.accepted.length,
		rounds: aiResult.rounds,
		file: fileContext,
	});
	return { matchResult: rewired, summary };
}
