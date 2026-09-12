/**
 * @file resolve-report.ts
 * @description
 *   競合の解決の実行レポートを組み立てる（roadmap-v04）。
 *
 *   書き出しと通知は `commands/shared/report-file.ts` を通す（ADR-260726-01。コマンドごとに
 *   独自の表示方法を実装しない）。ここが持つのは**文面だけ**である。
 *
 *   レポートに必ず残すのは2つ。**何を機械が決めたか**（人が見返せるように）と、**何が
 *   決まらずに残ったか**。決まらなかった件が残っているときは、そのファイルが1バイトも
 *   書き換わっていないことも書く。
 *
 * @module commands/conflict/resolve-report
 */
import * as vscode from "vscode";
import { conflictKindLabel } from "./conflict-kind";
import type { ConflictResolutionPlan, PendingChoice, ResolutionOutcome, ResolutionPlan } from "./resolution-plan";

/** 消した側には見せる値が無いので、その場の言葉で「削除」と書く */
function valueCell(text: string, deleted: boolean | undefined): string {
	return deleted ? vscode.l10n.t("deleted") : escapeCell(text);
}

/** 決まらずに残った件を一覧にする */
function remainingSection(plan: ResolutionPlan, outcome: ResolutionOutcome): string[] {
	if (outcome.remainingCount === 0) {
		return [];
	}
	const lines = [
		"",
		vscode.l10n.t(
			"**{0} conflict(s) still need your decision.** This file has not been changed at all — writing back only part of it would drop the other side of whatever is left.",
			outcome.remainingCount,
		),
		"",
		`| ${vscode.l10n.t("Entry")} | ${vscode.l10n.t("Yours")} | ${vscode.l10n.t("Theirs")} |`,
		"|---|---|---|",
	];
	for (const item of plan.pending) {
		lines.push(`| ${escapeCell(item.label)} | ${cells(item).join(" | ")} |`);
	}
	return lines;
}

/** 両側の値の欄 */
function cells(item: PendingChoice): [string, string] {
	return [valueCell(item.oursText, item.oursDeleted), valueCell(item.theirsText, item.theirsDeleted)];
}

/** 表のセルに入れても壊れないようにする */
function escapeCell(text: string): string {
	return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/**
 * レポートの本文を組み立てる。
 *
 * @param summary 実行前の計画
 * @param outcomes 対象ごとの結果
 */
export function buildConflictReport(
	summary: ConflictResolutionPlan,
	outcomes: readonly ResolutionOutcome[],
): string {
	const lines: string[] = [`# ${vscode.l10n.t("Merge conflict resolution")}`, ""];

	const remainingTotal = outcomes.reduce((sum, outcome) => sum + outcome.remainingCount, 0);

	lines.push(
		vscode.l10n.t("- Merged automatically (nothing to decide): {0}", summary.autoResolvedTotal),
		vscode.l10n.t("- Still waiting for your decision: {0}", remainingTotal),
		"",
	);

	if (summary.failures.length > 0) {
		lines.push(vscode.l10n.t("## Files that could not be read"), "");
		for (const failure of summary.failures) {
			lines.push(`- \`${failure.filePath}\` — ${escapeCell(failure.error)}`);
		}
		lines.push("");
	}

	for (const outcome of outcomes) {
		const plan = summary.plans.find((candidate) => candidate.filePath === outcome.filePath);
		lines.push(`## ${conflictKindLabel(outcome.kind)}`, "");
		lines.push(`\`${outcome.filePath}\``, "");

		if (outcome.error) {
			lines.push(vscode.l10n.t("Could not be resolved: {0}", outcome.error), "");
			continue;
		}
		if (outcome.skipped) {
			lines.push(
				vscode.l10n.t("You cancelled before this one was reached. It has not been changed at all."),
				"",
			);
			continue;
		}

		lines.push(
			vscode.l10n.t("- Entries kept without a decision: {0}", outcome.autoResolvedCount),
			vscode.l10n.t("- File rewritten: {0}", outcome.written ? vscode.l10n.t("yes") : vscode.l10n.t("no")),
		);
		if (plan && plan.deletedKeys.length > 0) {
			lines.push(vscode.l10n.t("- Entries the other side deleted: {0}", plan.deletedKeys.length));
		}
		if (outcome.unseatedCount && outcome.unseatedCount > 0) {
			lines.push(
				vscode.l10n.t(
					"- Rows taken off their seat by the merge: {0}. Both rows are kept; which one goes back is matched against your documents.",
					outcome.unseatedCount,
				),
			);
		}

		if (plan) {
			lines.push(...remainingSection(plan, outcome));
		}
		lines.push("");
	}

	return `${lines.join("\n")}\n`;
}
