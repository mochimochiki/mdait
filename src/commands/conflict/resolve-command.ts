/**
 * @file resolve-command.ts
 * @description
 *   ✨`競合を AI で解決` の入口（roadmap-v04 P02）。
 *
 *   **確認ダイアログは AI へ問い合わせる前に出す**（UX-P4）。判定が終わってから「これで
 *   よいですか」と聞く形にすると、断ったときには既に費用が出ている。計画を作る段では
 *   1バイトも書かず、AI も呼ばないので、件数も概算も承認の前に言える。
 *
 *   **API キーが無くても止まらない。** AI を呼ばずに、鍵の突き合わせで決まる分だけを
 *   片付けて残りを人へ回す（ADR-260911-02。器だけで全件を解決できる）。
 *
 * @module commands/conflict/resolve-command
 */
import * as path from "node:path";
import * as vscode from "vscode";
import { Configuration } from "../../infra/config/configuration";
import { AIServiceBuilder } from "../../infra/llm/ai-service-builder";
import { getResponseLanguage } from "../../infra/llm/response-language";
import { Logger, formatError } from "../../infra/logging/logger";
import { PromptProvider } from "../../prompts";
import { notifyWithReport, writeReport } from "../shared/report-file";
import { ConflictJudge } from "./conflict-judge";
import { buildConflictReport } from "./resolve-report";
import { type PreparedResolution, executeResolution, prepareResolution } from "./resolve-core";
import { collectWorkspaceConflicts, invalidateWorkspaceConflicts } from "../../ui/status/conflict-source";

const logger = Logger.getInstance();

/**
 * 承認をもらう。**AI へ問い合わせる前に**、対象件数・何を書くか・取り消せるかを見せる。
 *
 * @returns 承認されたか
 */
async function confirm(prepared: PreparedResolution, willUseAi: boolean): Promise<boolean> {
	const { autoResolvedTotal, pendingTotal, plans } = prepared.summary;
	const files = plans.map((plan) => path.basename(plan.filePath)).join(", ");

	// 祖先が取れていない対象があれば、そのことを言う。**祖先があるかどうかで、人が決める
	// 件数が実際に変わる**（実測: 片方だけが既存の語を直した形は、祖先があれば決定的に
	// 決まるが、無いと人に回る）。次からのために設定を勧める
	const missingBase = plans.some((plan) => plan.pending.length > 0 && !plan.hasBase);

	const detail = [
		vscode.l10n.t("{0} entry/entries can be merged automatically, with nothing to decide.", autoResolvedTotal),
		willUseAi
			? vscode.l10n.t(
					"{0} entry/entries have a different value for the same key. These will be sent to the AI, which can only pick one of the two existing values — it never writes new text.",
					pendingTotal,
				)
			: vscode.l10n.t(
					"{0} entry/entries have a different value for the same key. No AI is configured, so these are left for you to decide.",
					pendingTotal,
				),
		vscode.l10n.t("Files to be rewritten: {0}", files),
		...(missingBase
			? [
					vscode.l10n.t(
						"This merge did not record what both sides started from, so cases where only one side changed something cannot be settled automatically. Setting git's merge.conflictStyle to diff3 (or zdiff3) leaves fewer of these for you.",
					),
				]
			: []),
		vscode.l10n.t(
			"A file is only rewritten once every one of its conflicts is settled, so nothing is half-written. Your working tree is not committed, so you can undo this with git or SVN.",
		),
	].join("\n\n");

	const proceed = willUseAi ? vscode.l10n.t("Resolve with AI") : vscode.l10n.t("Resolve without AI");
	const answer = await vscode.window.showWarningMessage(
		vscode.l10n.t("Resolve {0} merge conflict(s) in .mdait?", autoResolvedTotal + pendingTotal),
		{ modal: true, detail },
		proceed,
	);
	return answer === proceed;
}

/**
 * 競合の解決を走らせる。
 */
export async function executeResolveConflicts(): Promise<void> {
	const config = Configuration.getInstance();
	if (!config.isConfigured()) {
		void vscode.window.showWarningMessage(vscode.l10n.t("mdait is not configured in this workspace yet."));
		return;
	}

	const conflicts = collectWorkspaceConflicts(config);
	if (conflicts.total === 0) {
		void vscode.window.showInformationMessage(vscode.l10n.t("There are no unresolved merge conflicts in .mdait."));
		return;
	}

	// **計画だけ先に作る。** ここで1バイトも書かず、AI も呼ばない
	const prepared = await prepareResolution(conflicts, config);
	if (prepared.summary.plans.length === 0) {
		void vscode.window.showInformationMessage(vscode.l10n.t("There are no unresolved merge conflicts in .mdait."));
		return;
	}

	// AI が使えるか。使えなくても止まらない（鍵の突き合わせで決まる分は片付く）
	let judge: ConflictJudge | undefined;
	try {
		const aiService = await new AIServiceBuilder().build(config.ai);
		const promptProvider = PromptProvider.getInstance();
		judge = new ConflictJudge(aiService, (id, variables) => promptProvider.getPromptParts(id, variables));
	} catch (error) {
		logger.info("conflict", "No AI available; resolving what is deterministic", formatError(error));
	}

	if (!(await confirm(prepared, judge !== undefined && prepared.summary.pendingTotal > 0))) {
		return; // 断られた。1バイトも書いていないし、問い合わせもしていない
	}

	const { outcomes, reasons } = await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: vscode.l10n.t("Resolving merge conflicts"),
			cancellable: true,
		},
		(progress, token) =>
			executeResolution(prepared, config, judge, getResponseLanguage(), progress, token),
	);

	// 解いたぶんファイルが変わったので、数え直させる
	invalidateWorkspaceConflicts();

	const report = buildConflictReport(prepared.summary, outcomes, reasons);
	const uri = await writeReport(config, "conflict", report);
	const remaining = outcomes.reduce((sum, outcome) => sum + outcome.remainingCount, 0);
	const written = outcomes.filter((outcome) => outcome.written).length;

	notifyWithReport(
		remaining > 0
			? vscode.l10n.t("Resolved {0} file(s); {1} conflict(s) still need your decision.", written, remaining)
			: vscode.l10n.t("Resolved every merge conflict in .mdait ({0} file(s)).", written),
		uri,
		remaining > 0 ? "warning" : "info",
	);
}
