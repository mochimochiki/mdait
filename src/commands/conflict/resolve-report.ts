/**
 * @file resolve-report.ts
 * @description
 *   競合の解決の実行レポートを組み立てる（roadmap-v04 P02）。
 *
 *   書き出しと通知は `commands/shared/report-file.ts` を通す（ADR-260726-01。コマンドごとに
 *   独自の表示方法を実装しない）。ここが持つのは**文面だけ**である。
 *
 *   レポートに必ず残すのは3つ。**何を機械が決めたか**（人が見返せるように）、**何を AI が
 *   決めたか とその理由**、**何が決まらずに残ったか**。決まらなかった件が残っているときは、
 *   そのファイルが1バイトも書き換わっていないことも書く。
 *
 * @module commands/conflict/resolve-report
 */
import * as vscode from "vscode";
import type { ConflictResolutionPlan, ResolutionOutcome, ResolutionPlan } from "./resolution-plan";

/** 対象の人が読む名前 */
function kindLabel(kind: ResolutionOutcome["kind"]): string {
	switch (kind) {
		case "unit-state":
			return vscode.l10n.t("Unit state");
		case "unit-registry":
			return vscode.l10n.t("Source snapshots");
		case "tm":
			return vscode.l10n.t("Translation memory");
		case "terms":
			return vscode.l10n.t("Glossary");
	}
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
		lines.push(`| ${escapeCell(item.label)} | ${escapeCell(item.oursText)} | ${escapeCell(item.theirsText)} |`);
	}
	return lines;
}

/** 表のセルに入れても壊れないようにする */
function escapeCell(text: string): string {
	return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/**
 * レポートの本文を組み立てる。
 *
 * @param summary 実行前の計画（何件を判定にかけたか）
 * @param outcomes 対象ごとの結果
 * @param reasons 鍵 → AI が付けた理由
 */
export function buildConflictReport(
	summary: ConflictResolutionPlan,
	outcomes: readonly ResolutionOutcome[],
	reasons: ReadonlyMap<string, string>,
): string {
	const lines: string[] = [`# ${vscode.l10n.t("Merge conflict resolution")}`, ""];

	const decidedTotal = outcomes.reduce((sum, outcome) => sum + outcome.decidedCount, 0);
	const remainingTotal = outcomes.reduce((sum, outcome) => sum + outcome.remainingCount, 0);

	lines.push(
		vscode.l10n.t("- Merged automatically (nothing to decide): {0}", summary.autoResolvedTotal),
		vscode.l10n.t("- Decided by AI: {0}", decidedTotal),
		vscode.l10n.t("- Still waiting for your decision: {0}", remainingTotal),
		"",
	);

	for (const outcome of outcomes) {
		const plan = summary.plans.find((candidate) => candidate.filePath === outcome.filePath);
		lines.push(`## ${kindLabel(outcome.kind)}`, "");
		lines.push(`\`${outcome.filePath}\``, "");

		if (outcome.error) {
			lines.push(vscode.l10n.t("Could not be resolved: {0}", outcome.error), "");
			continue;
		}

		lines.push(
			vscode.l10n.t("- Entries kept without a decision: {0}", outcome.autoResolvedCount),
			vscode.l10n.t("- Entries decided: {0}", outcome.decidedCount),
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

		// AI が決めた件と、その理由
		const decidedHere = (plan?.pending ?? []).filter((item) => reasons.has(item.key));
		if (decidedHere.length > 0) {
			lines.push("", `| ${vscode.l10n.t("Entry")} | ${vscode.l10n.t("Why")} |`, "|---|---|");
			for (const item of decidedHere) {
				lines.push(`| ${escapeCell(item.label)} | ${escapeCell(reasons.get(item.key) ?? "")} |`);
			}
		}

		if (plan) {
			lines.push(...remainingSection(plan, outcome));
		}
		lines.push("");
	}

	return `${lines.join("\n")}\n`;
}
