/**
 * @file resolve-command.ts
 * @description
 *   `競合を解決` の入口（roadmap-v04）。
 *
 *   **AI を1回も呼ばない**（ADR-260912-04）。片付くのは鍵の突き合わせで決まる分だけで、
 *   同じ鍵に別の値が来た件はツリーの行で人が決める。だから ✨ も付かないし、API キーの
 *   有無で挙動が変わることもない。
 *
 *   計画を作る段では1バイトも書かないので、**承認の前に**何件が決まり、何件が残り、
 *   どのファイルを書き換えるかを言える。
 *
 * @module commands/conflict/resolve-command
 */
import * as path from "node:path";
import * as vscode from "vscode";
import { Configuration } from "../../infra/config/configuration";
import { notifyWithReport, writeReport } from "../shared/report-file";
import { buildConflictReport } from "./resolve-report";
import { type PreparedResolution, executeResolution, prepareResolution } from "./resolve-core";
import { collectWorkspaceConflicts, invalidateWorkspaceConflicts } from "../../ui/status/conflict-source";

/**
 * 承認をもらう。何件を決めることになるかと、どのファイルを書き換えるかだけを見せる。
 *
 * **解説を書かない。** 「まだ書き換わらない」「取り消せる」といった説明は、操作の結果を
 * 見れば分かることで、ここで読ませる意味がない（`docs/ux.md` §3.3: 確認ダイアログに
 * 載せてよいのは、これから起きること・対象件数・取り消せるかどうか）。
 *
 * @returns 承認されたか
 */
async function confirm(prepared: PreparedResolution): Promise<boolean> {
	const { autoResolvedTotal, pendingTotal, wholeFileCount, plans } = prepared.summary;
	const files = plans.map((plan) => path.basename(plan.filePath)).join(", ");

	// 0 の項目は出さない（見えている数字は必ず中身のあるものにする）
	const counts = [
		...(pendingTotal > 0 ? [vscode.l10n.t("you decide {0}", pendingTotal)] : []),
		...(autoResolvedTotal > 0 ? [vscode.l10n.t("automatic {0}", autoResolvedTotal)] : []),
		...(wholeFileCount > 0 ? [vscode.l10n.t("rewritten whole: {0} file(s)", wholeFileCount)] : []),
	].join(" ／ ");

	const detail = [counts, vscode.l10n.t("Rewrites: {0}", files)].filter(Boolean).join("\n\n");
	const proceed = vscode.l10n.t("Resolve");
	const answer = await vscode.window.showWarningMessage(
		vscode.l10n.t("Resolve the merge conflicts in .mdait?"),
		{ modal: true, detail },
		proceed,
	);
	return answer === proceed;
}

/**
 * 計画が1つも作れなかったときに、何が残っているのかを伝える。
 *
 * **「計画が無い」と「競合が無い」は違う。** 壊れて読めなかった対象や、同期が片付ける
 * 降ろされた行が残っていることがある。黙って「競合はありません」と言うと、ツリーには
 * 未解決の行が出ているのに片付ける手立てが見えなくなる。
 */
function reportNothingPlanned(prepared: PreparedResolution): void {
	const { failures, heldRowCount } = prepared.summary;
	if (failures.length > 0) {
		const names = failures.map((failure) => path.basename(failure.filePath)).join(", ");
		void vscode.window.showErrorMessage(
			vscode.l10n.t("These conflicted files in .mdait could not be read, so they were left untouched: {0}", names),
		);
		return;
	}
	if (heldRowCount > 0) {
		void vscode.window.showInformationMessage(
			vscode.l10n.t(
				"No file in .mdait has conflict markers left. {0} row(s) are still waiting to be matched against your documents — run Sync.",
				heldRowCount,
			),
		);
		return;
	}
	void vscode.window.showInformationMessage(vscode.l10n.t("There are no unresolved merge conflicts in .mdait."));
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
		reportNothingPlanned(prepared);
		return;
	}

	if (!(await confirm(prepared))) {
		return; // 断られた。1バイトも書いていない
	}

	const outcomes = await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: vscode.l10n.t("Resolving merge conflicts"),
			cancellable: true,
		},
		(progress, token) => executeResolution(prepared, config, progress, token),
	);

	// 解いたぶんファイルが変わったので、数え直させる
	invalidateWorkspaceConflicts();

	const report = buildConflictReport(prepared.summary, outcomes);
	const uri = await writeReport(config, "conflict", report);
	const remaining = outcomes.reduce((sum, outcome) => sum + outcome.remainingCount, 0);
	const written = outcomes.filter((outcome) => outcome.written).length;
	// **書けなかった対象と、読めなかった対象を数に入れる。** 入れないと、書き込みが
	// 失敗しても「全部解決しました」と出る
	const unfinished =
		outcomes.filter((outcome) => outcome.error !== undefined || outcome.skipped === true).length +
		prepared.summary.failures.length;

	notifyWithReport(
		unfinished > 0
			? vscode.l10n.t("Could not write {0} file(s).", unfinished)
			: remaining > 0
				? vscode.l10n.t("Decide {0} more to write.", remaining)
				: vscode.l10n.t("Resolved the merge conflicts."),
		uri,
		unfinished > 0 || remaining > 0 ? "warning" : "info",
		// 残っているときだけ、次の一手（一覧を開く）をレポートより前に置く
		remaining > 0 && unfinished === 0
			? {
					label: vscode.l10n.t("Open the list"),
					run: () => void vscode.commands.executeCommand("mdait.status.focus"),
				}
			: undefined,
	);
}
