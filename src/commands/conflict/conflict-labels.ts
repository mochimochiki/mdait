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
import * as path from "node:path";
import * as vscode from "vscode";
import type { ChoiceSide, PendingChoice, ResolutionPlan } from "./resolution-plan";

/**
 * 画面が話す「どちらの人の変更か」。git の ours / theirs とは**同じではない** —
 * rebase の途中と stash pop では ours が相手の変更になる（`ResolutionPlan.mineSide`）。
 */
export type ConflictParty = "you" | "they";

/** その人の変更が、git のどちらの側にあるか */
export function sideOf(plan: Pick<ResolutionPlan, "mineSide">, party: ConflictParty): ChoiceSide {
	if (party === "you") {
		return plan.mineSide;
	}
	return plan.mineSide === "ours" ? "theirs" : "ours";
}

/** git のその側が、どちらの人の変更か */
export function partyOf(plan: Pick<ResolutionPlan, "mineSide">, side: ChoiceSide): ConflictParty {
	return side === plan.mineSide ? "you" : "they";
}

/** その人の側を消した件か（その側を採ると項目ごと消える） */
export function deletedBy(item: PendingChoice, side: ChoiceSide): boolean {
	return (side === "ours" ? item.oursDeleted : item.theirsDeleted) === true;
}

/**
 * 競合した対象の名前（ツリー・進捗・レポートで共通）＝ **ファイル名そのもの**。
 *
 * 種別ごとの呼び名（「ユニットの状態」「原文の控え」）を作らない。**その言葉は
 * mdait の中にしか無く、人が開くファイルの名前と対応しない** — ツリーで名前を見て
 * `.mdait` を開くと、そこにあるのは `unit-state` と `unit-registry` である。
 * 用語集はファイル名を設定で変えられる（`terms.filename`）ので、その意味でも
 * 固定の呼び名より実物の名前のほうが正しい（何が起きているかの説明は Hover が持つ）。
 */
export function conflictTargetLabel(filePath: string): string {
	return path.basename(filePath);
}

/**
 * 片側の値を人に見せる形。
 *
 * **消した側には見せる値が無い**（`oursText` / `theirsText` は空で来る）ので、その場の
 * 言葉で「削除」と書く。祖先の値を出すと、その側を採れば値が戻ると読めてしまう。
 */
export function conflictSideText(item: PendingChoice, side: ChoiceSide): string {
	if (deletedBy(item, side)) {
		return vscode.l10n.t("deleted");
	}
	return side === "ours" ? item.oursText : item.theirsText;
}
