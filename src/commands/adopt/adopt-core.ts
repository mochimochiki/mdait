/**
 * @file adopt-core.ts
 * @description
 *   既存翻訳の取り込みウィザードのオーケストレーター。
 *   `sync(adopt+align)` → `AI翻訳レビュー` → （オプション）用語集構築 → TM構築 を順に呼ぶ
 *   薄い合成であり、各段のロジックは一切再実装しない（ADR-260706-01・ADR-260711-06）。
 *   各段を注入可能にしてテスト容易性を確保する（AI に触れる段は各モジュールでテスト済み）。
 * @module commands/adopt/adopt-core
 */

import * as vscode from "vscode";
import type { Configuration, TransPair } from "../../infra/config/configuration";
import { FileExplorer } from "../../infra/workspace/file-explorer";
import { executeAiReviewForFiles } from "../ai-review/review-command";
import type { AiReviewOptions } from "../ai-review/review-core";
import type { AiReviewFileResult } from "../ai-review/review-result";
import { collectWorkspaceReviewTargets } from "../ai-review/review-targets";
import { type SyncCommandOptions, type SyncResult, syncCommand } from "../sync/sync-command";
import { detectTerm_CoreProc } from "../term/command-detect";
import type { TermEntry } from "../term/term-entry";
import { type TermExpandResult, expandTerm_CoreProc } from "../term/command-expand";
import { UnitPairCollector } from "../term/unit-pair-collector";
import { executeTmCommitForFile } from "../tm/command-commit";
import type { TmCommitResult } from "../tm/commit-processor";
import type { AdoptOutcome, AdoptStageError, AdoptTermSummary, AdoptTmSummary } from "./adopt-result";

/** 取り込みウィザードのオプション */
export interface AdoptOptions {
	/** true の場合はレビュー段でマーカーを変更せず、用語集・TM 段をスキップする（知識ストア非書き込み） */
	dryRun?: boolean;
	/** 用語集構築段（term.detect → term.expand）を実行するか */
	buildGlossary?: boolean;
	/** TM構築段（tm.commit）を実行するか */
	buildTm?: boolean;
}

type Progress = vscode.Progress<{ message?: string; increment?: number }>;

/**
 * オーケストレーターが呼ぶ各段。テストではスタブを注入する。
 */
export interface AdoptStages {
	/** sync(adopt+align) 段 */
	runSync(options: SyncCommandOptions): Promise<SyncResult | undefined>;
	/** レビュー・TM 対象の全ターゲットファイルを列挙する */
	collectTargets(config: Configuration): Promise<string[]>;
	/** AI翻訳レビュー段 */
	runReview(
		files: string[],
		config: Configuration,
		options: AiReviewOptions,
		progress: Progress,
		token: vscode.CancellationToken,
	): Promise<AiReviewFileResult[]>;
	/** 用語検出の対象ソースファイルを列挙する（transPair ごと） */
	collectSourceFiles(pair: TransPair, config: Configuration): Promise<string[]>;
	/** 用語検出段（transPair ごと） */
	runTermDetect(
		pair: TransPair,
		sourceFiles: string[],
		progress: Progress,
		token: vscode.CancellationToken,
	): Promise<TermEntry[]>;
	/** 用語訳補完段（transPair ごと） */
	runTermExpand(pair: TransPair, progress: Progress, token: vscode.CancellationToken): Promise<TermExpandResult>;
	/** TM登録段（ターゲットファイルごと） */
	runTmCommit(
		targetFile: string,
		config: Configuration,
		progress: Progress,
		token: vscode.CancellationToken,
	): Promise<TmCommitResult>;
}

/** 本番の各段実装（既存のプリミティブへ配線するだけ） */
export const defaultAdoptStages: AdoptStages = {
	// sync が投げたら「走らなかった」として畳む（従来 undefined を返していたのと同じ意味）。
	// 取り込みは後段を止めて aborted で安全に終わる
	runSync: async (options) => {
		try {
			return await syncCommand(options);
		} catch {
			return undefined;
		}
	},
	collectTargets: (config) => collectWorkspaceReviewTargets(config, new FileExplorer()),
	runReview: (files, config, options, progress, token) =>
		executeAiReviewForFiles(files, config, options, progress, token),
	collectSourceFiles: (pair, config) => new FileExplorer().getSourceFiles(pair.sourceDir, config),
	runTermDetect: async (pair, sourceFiles, progress, token) => {
		const collection = await new UnitPairCollector().collectFromFiles(sourceFiles, pair, token);
		return detectTerm_CoreProc(collection.pairs, pair, progress, token);
	},
	runTermExpand: (pair, progress, token) => expandTerm_CoreProc(pair, progress, token),
	runTmCommit: (targetFile, config, progress, token) => executeTmCommitForFile(targetFile, config, progress, token),
};

/**
 * 既存翻訳の取り込みウィザードを実行する（合成オーケストレーター）。
 *
 * 1. sync(adopt+align): 取り込み＋位置ズレのAI補正（管理済みサイトでは no-op）
 * 2. AI翻訳レビュー: adopt 済みペアをトリアージ（高確信 match は need:review 自動解除）
 * 3. 用語検出（オプション）: 確立した対訳ペアから用語を抽出して用語集へ追記
 * 4. 用語訳補完（オプション）: 訳語未設定の用語を既訳から推定して補完
 * 5. TM登録（オプション）: レビュー通過ペア（from あり ∧ need なし）を TM へ登録
 *
 * 各段は冪等なので、途中キャンセル→再実行で残りから再開できる。
 * sync が undefined（設定不正等）の場合は aborted で安全に中断し後段は行わない。
 * オプション段（3〜5）の失敗は stageErrors に記録して続行する（TM 段は用語集段に依存しない）。
 * tm.commit は「from あり ∧ need なし」のみ対象のため、レビューでエスカレーションされた
 * ユニットが TM に混入することは構造的にない。
 */
export async function executeAdopt(
	config: Configuration,
	options: AdoptOptions,
	progress: Progress,
	token: vscode.CancellationToken,
	stages: AdoptStages = defaultAdoptStages,
): Promise<AdoptOutcome> {
	const dryRun = options.dryRun === true;
	// dryRun は知識ストア（用語集・TM）へ書き込まないため、オプション段自体をスキップする
	const buildGlossary = options.buildGlossary === true && !dryRun;
	const buildTm = options.buildTm === true && !dryRun;
	const totalStages = 2 + (buildGlossary ? 2 : 0) + (buildTm ? 1 : 0);
	const stageErrors: AdoptStageError[] = [];

	const partial = (
		sync: SyncResult | undefined,
		review: AiReviewFileResult[],
		term?: AdoptTermSummary,
		tm?: AdoptTmSummary,
	): AdoptOutcome => ({ sync, review, term, tm, stageErrors, dryRun, aborted: false });

	// Phase 1: sync(adopt+align)
	progress.report({ message: vscode.l10n.t("({0}/{1}) Sync (adopt + AI align)...", 1, totalStages) });
	// token を渡さないと、取り消しても AIアラインが最後のファイルまで走り続ける（ADR-260903-04）
	const sync = await stages.runSync({ adopt: true, align: true, token });
	if (!sync) {
		return { sync: undefined, review: [], term: undefined, tm: undefined, stageErrors, dryRun, aborted: true };
	}
	if (token.isCancellationRequested) {
		return partial(sync, []);
	}

	// Phase 2: AI翻訳レビュー
	progress.report({ message: vscode.l10n.t("({0}/{1}) AI translation review...", 2, totalStages) });
	const files = await stages.collectTargets(config);
	// ターゲット列挙後に再度キャンセルを確認する。ここで抜けることで AIService の
	// 無駄な構築（buildPairVerifier）や API 呼び出しを避け、キャンセル応答性を保つ。
	if (token.isCancellationRequested) {
		return partial(sync, []);
	}
	const review = files.length > 0 ? await stages.runReview(files, config, { dryRun }, progress, token) : [];

	// Phase 3-4: 用語集構築（オプション）
	let term: AdoptTermSummary | undefined;
	if (buildGlossary) {
		if (token.isCancellationRequested) {
			return partial(sync, review);
		}
		term = { detected: 0, expanded: 0, remaining: 0 };
		progress.report({ message: vscode.l10n.t("({0}/{1}) Detecting terms...", 3, totalStages) });
		for (const pair of config.transPairs) {
			if (token.isCancellationRequested) {
				return partial(sync, review, term);
			}
			try {
				const sourceFiles = await stages.collectSourceFiles(pair, config);
				const detected = await stages.runTermDetect(pair, sourceFiles, progress, token);
				term.detected += detected.length;
			} catch (error) {
				stageErrors.push({
					stage: "termDetect",
					scope: `${pair.sourceLang} -> ${pair.targetLang}`,
					message: (error as Error).message,
				});
			}
		}
		progress.report({ message: vscode.l10n.t("({0}/{1}) Expanding term translations...", 4, totalStages) });
		for (const pair of config.transPairs) {
			if (token.isCancellationRequested) {
				return partial(sync, review, term);
			}
			try {
				const expanded = await stages.runTermExpand(pair, progress, token);
				term.expanded += expanded.expanded;
				term.remaining += expanded.remaining;
			} catch (error) {
				stageErrors.push({
					stage: "termExpand",
					scope: `${pair.sourceLang} -> ${pair.targetLang}`,
					message: (error as Error).message,
				});
			}
		}
	}

	// Phase 5: TM構築（オプション。用語集段の失敗があっても実行する）
	let tm: AdoptTmSummary | undefined;
	if (buildTm) {
		if (token.isCancellationRequested) {
			return partial(sync, review, term);
		}
		const tmStageNo = buildGlossary ? 5 : 3;
		tm = { files: 0, processedUnits: 0, newEntries: 0, existingEntries: 0, warnedEntries: 0, errorUnits: 0 };
		for (const [index, file] of files.entries()) {
			if (token.isCancellationRequested) {
				return partial(sync, review, term, tm);
			}
			progress.report({
				message: vscode.l10n.t("({0}/{1}) TM commit: {2}/{3} files", tmStageNo, totalStages, index + 1, files.length),
			});
			try {
				const result = await stages.runTmCommit(file, config, progress, token);
				tm.files += 1;
				tm.processedUnits += result.processedUnits;
				tm.newEntries += result.newEntries;
				tm.existingEntries += result.existingEntries;
				tm.warnedEntries += result.warnedEntries;
				tm.errorUnits += result.errorUnits;
			} catch (error) {
				stageErrors.push({ stage: "tmCommit", scope: file, message: (error as Error).message });
			}
		}
	}

	return { sync, review, term, tm, stageErrors, dryRun, aborted: false };
}
