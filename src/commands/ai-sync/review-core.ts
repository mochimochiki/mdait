/**
 * @file review-core.ts
 * @description
 *   AIペアリング検証のコア処理（1ファイル単位）。
 *   VS Code コマンドと LM tool（mdait_aiReview）の双方から再利用される。
 *   マーカー変異は「自動承認時の removeNeedTag()」のみで、hash / from / 本文には触れない
 *   （ADR-260704-07）。
 * @module commands/ai-sync/review-core
 */

import * as fs from "node:fs";
import * as vscode from "vscode";
import { markdownParser } from "../../core/markdown/parser";
import { StatusManager } from "../../core/status/status-manager";
import { UnitStateStore } from "../../core/unit-state/unit-state-store";
import type { Configuration } from "../../infra/config/configuration";
import { resolveMarkerIO } from "../../infra/config/marker-io";
import { Logger, formatError } from "../../infra/logging/logger";
import { flushDirtyDocument } from "../../infra/workspace/dirty-document";
import { FileExplorer } from "../../infra/workspace/file-explorer";
import { FileMutex } from "../../infra/workspace/file-mutex";
import { ensureMdaitDir } from "../../infra/workspace/mdait-dir";
import { SummaryManager } from "../../ui/hover/summary-manager";
import { type ReviewCollectMode, collectReviewPairs } from "./pair-collector";
import type { PairVerifier } from "./pair-verifier";
import {
	type AiReviewFileResult,
	type UnitReviewResult,
	createEmptyFileResult,
	decideReviewAction,
	formatReviewReason,
} from "./review-result";

const logger = Logger.getInstance();

/** AIペアリング検証のオプション */
export interface AiReviewOptions {
	/** true の場合はマーカーを一切変更しない（レポートのみ） */
	dryRun?: boolean;
	/**
	 * 検証対象の範囲（既定 "pending"）。
	 * - "pending": need:review ユニットのみ（AIペアリング検証・従来挙動）
	 * - "audit": 確定済みペア（from あり・need なし）も監査し、ドリフト検出時に need:review を付与
	 */
	mode?: ReviewCollectMode;
}

/**
 * 1ファイル分のAIペアリング検証を実行する。
 *
 * - 対象: ターゲット側の「from あり ∧ need:review」ユニット（0件なら即終了＝冪等）
 * - 自動承認されたユニットのみ need:review を解除しファイルへ書き戻す
 * - キャンセル時も完了分の承認は書き込む（再実行で残りを処理できる）
 * - 1ユニットの失敗（リトライ枯渇・例外）はファイル全体を止めない
 *
 * @param targetFile ターゲットファイルの絶対パス
 * @param config 設定
 * @param verifier AI検証器
 * @param options dryRun 等のオプション
 * @param progress 進捗レポーター
 * @param token キャンセルトークン
 */
export async function executeAiReviewForFile(
	targetFile: string,
	config: Configuration,
	verifier: PairVerifier,
	options: AiReviewOptions = {},
	progress?: vscode.Progress<{ message?: string; increment?: number }>,
	token?: vscode.CancellationToken,
): Promise<AiReviewFileResult> {
	const result = createEmptyFileResult(targetFile);
	const fileExplorer = new FileExplorer();

	const transPair = fileExplorer.getTransPairFromTarget(targetFile, config);
	if (!transPair) {
		throw new Error(vscode.l10n.t("No translation pair found for file: {0}", targetFile));
	}
	const sourceFile = fileExplorer.getSourcePath(targetFile, transPair);
	if (!sourceFile || !fs.existsSync(sourceFile)) {
		throw new Error(vscode.l10n.t("Source file not found for: {0}", targetFile));
	}

	// external マーカーの場合は unit-state ストアを先にロードする（sync と同じ経路）
	if (config.isExternalMarkers()) {
		const mdaitDir = await ensureMdaitDir();
		if (mdaitDir) {
			UnitStateStore.getInstance().ensureLoaded(mdaitDir);
		}
	}

	// 読み取り〜書き戻しの間に sync/trans がファイルを変更しないよう、ペア単位で排他する
	await FileMutex.getInstance().runExclusive([sourceFile, targetFile], async () => {
		await flushDirtyDocument(sourceFile);
		await flushDirtyDocument(targetFile);

		const decoder = new TextDecoder("utf-8");
		const sourceContent = decoder.decode(await vscode.workspace.fs.readFile(vscode.Uri.file(sourceFile)));
		const targetContent = decoder.decode(await vscode.workspace.fs.readFile(vscode.Uri.file(targetFile)));

		const sourceIO = resolveMarkerIO(config, sourceFile, "source");
		const targetIO = resolveMarkerIO(config, targetFile, "target");
		const source = markdownParser.parse(sourceContent, config, sourceIO.provider, sourceIO.ctx);
		const target = markdownParser.parse(targetContent, config, targetIO.provider, targetIO.ctx);

		const mode = options.mode ?? "pending";
		const allPairs = collectReviewPairs(source.units, target.units, mode);
		if (allPairs.length === 0) {
			return;
		}
		const pairs = allPairs.slice(0, config.aiSync.review.maxUnitsPerRun);

		const policy = {
			autoApprove: options.dryRun ? false : config.aiSync.review.autoApprove,
			threshold: config.aiSync.review.autoApproveThreshold,
		};
		const summaryManager = SummaryManager.getInstance();
		// removeNeedTag（承認）と setNeed（フラグ付与）の両方を数え、書き戻し要否のゲートに使う
		let mutationCount = 0;

		for (let i = 0; i < pairs.length; i++) {
			if (token?.isCancellationRequested) {
				logger.info("aiSync", "AI review cancelled", { file: targetFile, processed: i });
				break;
			}
			const pair = pairs[i];
			const marker = pair.targetUnit.marker;
			const unitResult: UnitReviewResult = {
				filePath: targetFile,
				unitHash: marker?.hash ?? "",
				fromHash: marker?.from ?? "",
				title: pair.targetUnit.title,
				issues: [],
				action: "kept",
			};
			progress?.report({
				message: vscode.l10n.t("{0}/{1} units", i + 1, pairs.length),
			});

			if (!pair.sourceUnit) {
				unitResult.action = "skipped";
				unitResult.reason = "Source unit not found for from hash";
				result.skipped++;
				result.unitResults.push(unitResult);
				continue;
			}

			try {
				const startedAt = Date.now();
				const verifyResult = await verifier.verify(
					{
						sourceLang: transPair.sourceLang,
						targetLang: transPair.targetLang,
						sourceText: pair.sourceUnit.content,
						targetText: pair.targetUnit.content,
						unitContext: { unitHash: marker?.hash, title: pair.targetUnit.title },
					},
					token,
				);
				const parsed = verifyResult.parsed;
				result.verified++;
				unitResult.verdict = parsed.verdict;
				unitResult.confidence = parsed.confidence;
				unitResult.issues = parsed.issues;
				unitResult.reason = parsed.reason;

				if (verifyResult.fallback) {
					unitResult.action = "error";
					result.errors++;
				} else {
					const action = decideReviewAction(parsed, policy);
					// 元が need:review（pending）か、確定済みペア（audit で拾った need なし）かで
					// マーカー変異の意味が変わる。settled は removeNeedTag する対象が無いため、
					// ドリフト（escalate）検出時のみ need:review を付与してフラグする。
					const isPending = marker?.need === "review";
					if (isPending) {
						if (action === "approve") {
							marker?.removeNeedTag();
							unitResult.action = "approved";
							mutationCount++;
							result.approved++;
						} else if (action === "escalate") {
							unitResult.action = "escalated";
							result.escalated++;
						} else {
							unitResult.action = "kept";
							result.kept++;
						}
					} else if (action === "escalate") {
						// 確定済みペアにドリフト（partial/mismatch）を検出 → レポートのみ（マーカー不変）。
						// audit は確定済みペアを毎回再スキャンするため、ここで need:review を書き戻すと
						// 意図的な単文乖離を毎回蒸し返し、人間の「承認（need:review 解除）」判断を上書き
						// してしまう。受理を記憶する仕組み（受理台帳）が入るまでは報告に留める。
						unitResult.action = "flagged";
						result.flagged++;
					} else {
						// 確定済みペアがクリーン（match/uncertain）→ 変更なし
						unitResult.action = "audited";
						result.audited++;
					}
				}

				// hover 表示用に判定理由を保存（approved も含めて可視化する）
				if (marker?.hash) {
					summaryManager.saveSummary(marker.hash, {
						unitHash: marker.hash,
						stats: { duration: (Date.now() - startedAt) / 1000 },
						reviewReasons: [formatReviewReason(parsed)],
						warnings: parsed.issues.length > 0 ? parsed.issues : undefined,
					});
				}
			} catch (error) {
				if (token?.isCancellationRequested) {
					logger.info("aiSync", "AI review cancelled during verification", { file: targetFile });
					break;
				}
				logger.warn("aiSync", "Unit verification error", {
					unitHash: marker?.hash,
					title: pair.targetUnit.title,
					...formatError(error),
				});
				unitResult.action = "error";
				unitResult.reason = (error as Error).message;
				result.errors++;
			}
			result.unitResults.push(unitResult);
		}

		// キャンセル時も完了分のマーカー変異（承認・フラグ）は書き込む（冪等なので再実行で残りを処理できる）
		if (mutationCount > 0 && !options.dryRun) {
			const encoder = new TextEncoder();
			const updatedContent = markdownParser.stringify(
				{ frontMatter: target.frontMatter, units: target.units },
				targetIO.provider,
				targetIO.ctx,
			);
			await vscode.workspace.fs.writeFile(vscode.Uri.file(targetFile), encoder.encode(updatedContent));
			result.markersChanged = true;
		}
	});

	// external マーカーの場合は unit-state ストアを保存する
	if (result.markersChanged && config.isExternalMarkers()) {
		const mdaitDir = await ensureMdaitDir();
		if (mdaitDir) {
			UnitStateStore.getInstance().save(mdaitDir);
		}
	}

	if (result.markersChanged) {
		await StatusManager.getInstance().refreshFileStatus(targetFile);
	}

	logger.info("aiSync", "AI review completed", {
		file: targetFile,
		mode: options.mode ?? "pending",
		verified: result.verified,
		approved: result.approved,
		escalated: result.escalated,
		flagged: result.flagged,
		audited: result.audited,
		kept: result.kept,
		skipped: result.skipped,
		errors: result.errors,
	});

	return result;
}
