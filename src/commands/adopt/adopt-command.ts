/**
 * @file adopt-command.ts
 * @description
 *   既存翻訳の取り込みウィザードのエントリーポイント。
 *   冒頭で QuickPick によりオプション段（用語集・TM 構築）をまとめてオプトインさせ、
 *   確認UIを1回出し（AI を使う段を列挙）、AIオンボーディングを通過してから
 *   executeAdopt を withProgress で実行する。取り込み〜知識ストア構築を1操作で回す。
 * @module commands/adopt/adopt-command
 */
import * as vscode from "vscode";
import { Configuration } from "../../infra/config/configuration";
import { Logger, formatError } from "../../infra/logging/logger";
import { AIOnboarding } from "../../infra/onboarding/ai-onboarding";
import { aggregateReviewResults } from "../ai-review/review-result";
import { type AdoptOptions, executeAdopt } from "./adopt-core";
import { openAdoptReport, writeAdoptReport } from "./adopt-report-file";
import type { AdoptOutcome } from "./adopt-result";

const logger = Logger.getInstance();

/**
 * 既存翻訳の取り込みコマンド（ワークスペース全体）。
 * Welcome ビュー / StatusTree のビュータイトル / コマンドパレットから呼び出される。
 */
export async function adoptCommand(): Promise<AdoptOutcome | undefined> {
	const config = Configuration.getInstance();
	const validationError = config.validate();
	if (validationError) {
		vscode.window.showErrorMessage(validationError);
		return;
	}

	// オプション段を冒頭でまとめてオプトインさせる（以後の途中確認なし）
	const options = await pickAdoptOptions(config);
	if (!options) {
		return;
	}

	// 確認UIを冒頭に1回（AI を使う段を列挙する。ADR-260705-01）
	const steps = buildAdoptStepList(options, config.aiReview.autoApprove);
	const confirm = await vscode.window.showInformationMessage(
		vscode.l10n.t(
			"Adopt existing translations? Steps: {0}. This updates translation markers{1}. Committing your workspace to git beforehand is recommended.",
			steps.join(", "),
			options.buildGlossary || options.buildTm ? vscode.l10n.t(" and writes to the glossary/TM") : "",
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
			title: vscode.l10n.t("Adopt Existing Translations"),
			cancellable: true,
		},
		async (progress, token) => {
			try {
				const outcome = await executeAdopt(config, options, progress, token);
				showAdoptResult(outcome);
				await showAdoptPreview(config, outcome);
				return outcome;
			} catch (error) {
				logger.error("adopt", "Adopt failed", formatError(error));
				vscode.window.showErrorMessage(vscode.l10n.t("Adopt error: {0}", (error as Error).message));
				return undefined;
			}
		},
	);
}

/**
 * オプション段（用語集・TM 構築）の QuickPick。両方とも既定でオン
 * （推奨フロー adopt → review → term → tm と一致）。TM 無効設定のときは TM 項目を出さない。
 * キャンセル（Escape）時は undefined を返す。
 */
async function pickAdoptOptions(config: Configuration): Promise<AdoptOptions | undefined> {
	const glossaryItem = {
		label: vscode.l10n.t("Build glossary"),
		detail: vscode.l10n.t("Detect terms from the adopted pairs and expand their translations (term detect + expand)."),
		picked: true,
		optionKind: "glossary" as const,
	};
	const tmItem = {
		label: vscode.l10n.t("Build translation memory"),
		detail: vscode.l10n.t("Register review-approved pairs into the translation memory (tm commit)."),
		picked: true,
		optionKind: "tm" as const,
	};
	const items = config.getTmEnabled() ? [glossaryItem, tmItem] : [glossaryItem];
	const picked = await vscode.window.showQuickPick(items, {
		title: vscode.l10n.t("Adopt Existing Translations: optional steps"),
		placeHolder: vscode.l10n.t("Select what to build together with the adoption (recommended: all)"),
		canPickMany: true,
	});
	if (!picked) {
		return undefined;
	}
	return {
		buildGlossary: picked.some((item) => item.optionKind === "glossary"),
		buildTm: picked.some((item) => item.optionKind === "tm"),
	};
}

/**
 * 確認ダイアログに列挙する実行段のリストを組み立てる（mdait_adopt の確認UIと共有）。
 * レビュー段の表記は aiReview.autoApprove に追従させる（無効時に「自動承認」と謳わない）。
 */
export function buildAdoptStepList(options: AdoptOptions, autoApprove: boolean): string[] {
	const steps = [
		vscode.l10n.t("adopt existing translations (need:review)"),
		vscode.l10n.t("AI-align mis-paired units"),
		autoApprove
			? vscode.l10n.t("AI translation review (auto-approves high-confidence matches)")
			: vscode.l10n.t("AI translation review (report only: autoApprove is off)"),
	];
	if (options.buildGlossary) {
		steps.push(vscode.l10n.t("build glossary"));
	}
	if (options.buildTm) {
		steps.push(vscode.l10n.t("build translation memory"));
	}
	return steps;
}

/**
 * 取り込み結果を通知表示する。
 */
function showAdoptResult(outcome: AdoptOutcome): void {
	if (outcome.aborted || !outcome.sync) {
		vscode.window.showErrorMessage(vscode.l10n.t("Adoption did not run. Check the mdait configuration."));
		return;
	}
	const agg = aggregateReviewResults(outcome.review);
	const parts = [
		vscode.l10n.t(
			"Adoption completed: {0} adopted, {1} align-corrected; review {2} approved, {3} escalated, {4} kept, {5} errors.",
			outcome.sync.totalAdopted,
			outcome.sync.totalAlignCorrections,
			agg.approved,
			agg.escalated,
			agg.kept,
			agg.errors,
		),
	];
	if (outcome.term) {
		parts.push(vscode.l10n.t("Glossary: {0} detected, {1} expanded.", outcome.term.detected, outcome.term.expanded));
	}
	if (outcome.tm) {
		parts.push(vscode.l10n.t("TM: {0} new, {1} updated.", outcome.tm.newEntries, outcome.tm.existingEntries));
	}
	if (outcome.stageErrors.length > 0) {
		parts.push(vscode.l10n.t("{0} step error(s) — see the report.", outcome.stageErrors.length));
	}
	const message = parts.join(" ");
	if (agg.escalated > 0 || agg.errors > 0 || outcome.stageErrors.length > 0) {
		vscode.window.showWarningMessage(message);
	} else {
		vscode.window.showInformationMessage(message);
	}
}

/**
 * 取り込み結果のレポートを `.mdait/adopt-report.md` へ書き出し、プレビューで開く。
 * sync が走った場合のみ表示する。
 */
async function showAdoptPreview(config: Configuration, outcome: AdoptOutcome): Promise<void> {
	if (outcome.aborted || !outcome.sync) {
		return;
	}
	const uri = await writeAdoptReport(config, outcome);
	if (uri) {
		await openAdoptReport(uri);
	}
}
