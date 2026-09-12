/**
 * @file conflict-labels.ts
 * @description
 *   競合の解決が人に見せる言葉を、**ここだけが持つ**。
 *
 *   同じことを2つのサーフェスが別々に書くと、片方だけ直して食い違う。対象の名前は
 *   ツリーの行・進捗・レポートの見出しの3か所に出るし、「消した側をどう見せるか」は
 *   Hover とレポートの両方に出る。
 *
 * @module commands/conflict/conflict-labels
 */
import * as vscode from "vscode";
import type { ConflictFileKind } from "../../core/conflict/mdait-conflicts";
import type { ChoiceSide, PendingChoice } from "./resolution-plan";

/** 競合した対象の名前（ツリー・進捗・レポートで共通） */
export function conflictKindLabel(kind: ConflictFileKind): string {
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

/**
 * 片側の値を人に見せる形。
 *
 * **消した側には見せる値が無い**（`oursText` / `theirsText` は空で来る）ので、その場の
 * 言葉で「削除」と書く。祖先の値を出すと、その側を採れば値が戻ると読めてしまう。
 */
export function conflictSideText(item: PendingChoice, side: ChoiceSide): string {
	if (side === "ours") {
		return item.oursDeleted ? vscode.l10n.t("deleted") : item.oursText;
	}
	return item.theirsDeleted ? vscode.l10n.t("deleted") : item.theirsText;
}
