/**
 * @file adopt-command.ts
 * @description
 *   AI同期（合成コマンド）のエントリーポイント。
 *   確認UIを冒頭に1回出し（AI を使う段を列挙）、AIオンボーディングを通過してから
 *   executeAdopt を withProgress で実行する。取り込み〜健全性監査を1操作で回す。
 * @module commands/adopt/adopt-command
 */
import * as vscode from "vscode";
import { Configuration } from "../../infra/config/configuration";
import { Logger, formatError } from "../../infra/logging/logger";
import { AIOnboarding } from "../../infra/onboarding/ai-onboarding";
import { executeAdopt } from "./adopt-core";
import { type AdoptOutcome, buildAdoptNextActions } from "./adopt-result";
import { AdoptResultContentProvider } from "./adopt-result-provider";
import { aggregateReviewResults } from "../ai-review/review-result";

const logger = Logger.getInstance();

/**
 * AI同期コマンド（ワークスペース全体）。
 * StatusTree のビュータイトル / コマンドパレットから呼び出される。
 */
export async function adoptCommand(): Promise<AdoptOutcome | undefined> {
	const config = Configuration.getInstance();
	const validationError = config.validate();
	if (validationError) {
		vscode.window.showErrorMessage(validationError);
		return;
	}

	// 確認UIを冒頭に1回（AI を使う段を列挙する。ADR-260705-01）
	const confirm = await vscode.window.showInformationMessage(
		vscode.l10n.t(
			"Run AI Sync? This performs three steps in order: (1) adopt existing translations (need:review), (2) AI-align mis-paired units, (3) AI pairing review (auto-approves high-confidence matches). It updates translation markers. Committing your workspace to git beforehand is recommended.",
		),
		{ modal: true },
		vscode.l10n.t("Yes"),
	);
	if (confirm !== vscode.l10n.t("Yes")) {
		return;
	}

	const aiOnboarding = AIOnboarding.getInstance();
	if (!(await aiOnboarding.checkAndShowFirstUseDialog())) {
		return;
	}

	return await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: vscode.l10n.t("AI Sync"),
			cancellable: true,
		},
		async (progress, token) => {
			try {
				const outcome = await executeAdopt(config, {}, progress, token);
				showAdoptResult(outcome);
				await showAdoptPreview(outcome);
				return outcome;
			} catch (error) {
				logger.error("adopt", "Adopt failed", formatError(error));
				vscode.window.showErrorMessage(vscode.l10n.t("AI sync error: {0}", (error as Error).message));
				return undefined;
			}
		},
	);
}

/**
 * AI同期結果を通知表示する。
 */
function showAdoptResult(outcome: AdoptOutcome): void {
	if (outcome.aborted || !outcome.sync) {
		vscode.window.showErrorMessage(vscode.l10n.t("AI sync: synchronization did not run. Check the mdait configuration."));
		return;
	}
	const agg = aggregateReviewResults(outcome.review);
	const message = vscode.l10n.t(
		"AI sync completed: {0} adopted, {1} align-corrected; review {2} approved, {3} escalated, {4} kept, {5} errors.",
		outcome.sync.totalAdopted,
		outcome.sync.totalAlignCorrections,
		agg.approved,
		agg.escalated,
		agg.kept,
		agg.errors,
	);
	if (agg.escalated > 0 || agg.errors > 0) {
		vscode.window.showWarningMessage(message);
	} else {
		vscode.window.showInformationMessage(message);
	}
}

/**
 * AI同期結果のプレビュードキュメントを開く。sync が走った場合のみ表示する。
 */
async function showAdoptPreview(outcome: AdoptOutcome): Promise<void> {
	if (outcome.aborted || !outcome.sync) {
		return;
	}
	AdoptResultContentProvider.getInstance().setContent(outcome);
	await AdoptResultContentProvider.openPreview();
}
