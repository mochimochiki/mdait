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
import type { ChoiceSide, PendingChoice } from "./resolution-plan";

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
	if (side === "ours") {
		return item.oursDeleted ? vscode.l10n.t("deleted") : item.oursText;
	}
	return item.theirsDeleted ? vscode.l10n.t("deleted") : item.theirsText;
}
