/**
 * @file adopt-core.ts
 * @description
 *   AI同期（合成コマンド）のオーケストレーター。
 *   `sync(adopt+align)` → 全ターゲット列挙 → `AIペアリング検証` を順に呼ぶ薄い合成であり、
 *   各段のロジックは一切再実装しない（ADR-260706-01）。
 *   各段を注入可能にしてテスト容易性を確保する（AI に触れる段は各モジュールでテスト済み）。
 * @module commands/adopt/adopt-core
 */

import * as vscode from "vscode";
import type { Configuration } from "../../infra/config/configuration";
import { FileExplorer } from "../../infra/workspace/file-explorer";
import { executeAiReviewForFiles } from "../ai-review/review-command";
import type { AiReviewFileResult } from "../ai-review/review-result";
import { collectWorkspaceReviewTargets } from "../ai-review/review-targets";
import type { AdoptOutcome } from "./adopt-result";
import { type SyncCommandOptions, type SyncResult, syncCommand } from "../sync/sync-command";
import type { AiReviewOptions } from "../ai-review/review-core";

/** AI同期のオプション */
export interface AdoptOptions {
	/** true の場合はレビュー段でマーカーを変更しない（sync 段は adopt を行うため dryRun 対象外） */
	dryRun?: boolean;
}

/**
 * オーケストレーターが呼ぶ各段。テストではスタブを注入する。
 */
export interface AdoptStages {
	/** sync(adopt+align) 段 */
	runSync(options: SyncCommandOptions): Promise<SyncResult | undefined>;
	/** レビュー対象の全ターゲットファイルを列挙する */
	collectTargets(config: Configuration): Promise<string[]>;
	/** AIペアリング検証段 */
	runReview(
		files: string[],
		config: Configuration,
		options: AiReviewOptions,
		progress: vscode.Progress<{ message?: string; increment?: number }>,
		token: vscode.CancellationToken,
	): Promise<AiReviewFileResult[]>;
}

/** 本番の各段実装（既存のプリミティブへ配線するだけ） */
export const defaultAdoptStages: AdoptStages = {
	runSync: (options) => syncCommand(options),
	collectTargets: (config) => collectWorkspaceReviewTargets(config, new FileExplorer()),
	runReview: (files, config, options, progress, token) =>
		executeAiReviewForFiles(files, config, options, progress, token),
};

/**
 * AI同期を実行する（合成オーケストレーター）。
 *
 * 1. sync(adopt+align): 取り込み＋位置ズレのAI補正（管理済みサイトでは no-op）
 * 2. 全ターゲットを列挙
 * 3. AIペアリング検証: adopt 済みペアをトリアージ（高確信 match は need:review 自動解除）
 *
 * 各段は冪等なので、途中キャンセル→再実行で残りから再開できる。
 * sync が undefined（設定不正等）の場合は aborted で安全に中断しレビューは行わない。
 */
export async function executeAdopt(
	config: Configuration,
	options: AdoptOptions,
	progress: vscode.Progress<{ message?: string; increment?: number }>,
	token: vscode.CancellationToken,
	stages: AdoptStages = defaultAdoptStages,
): Promise<AdoptOutcome> {
	const dryRun = options.dryRun === true;

	// Phase 1: sync(adopt+align)
	progress.report({ message: vscode.l10n.t("Sync (adopt + AI align)...") });
	const sync = await stages.runSync({ adopt: true, align: true });
	if (!sync) {
		return { sync: undefined, review: [], dryRun, aborted: true };
	}
	if (token.isCancellationRequested) {
		return { sync, review: [], dryRun, aborted: false };
	}

	// Phase 2: AIペアリング検証
	progress.report({ message: vscode.l10n.t("AI pairing review...") });
	const files = await stages.collectTargets(config);
	// ターゲット列挙後に再度キャンセルを確認する。ここで抜けることで AIService の
	// 無駄な構築（buildPairVerifier）や API 呼び出しを避け、キャンセル応答性を保つ。
	if (token.isCancellationRequested || files.length === 0) {
		return { sync, review: [], dryRun, aborted: false };
	}
	const review = await stages.runReview(files, config, { dryRun }, progress, token);

	return { sync, review, dryRun, aborted: false };
}
