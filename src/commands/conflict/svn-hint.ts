/**
 * @file svn-hint.ts
 * @description
 *   競合を解き終えたときの文言に、Subversion の作業コピーなら「SVN の側でも解決済みにする」を添える。
 *
 *   mdait が `.mdait` の中身を解いても、svn はそのファイルを競合中として持ち続け、
 *   「解決済み」にするまでコミットを拒む（`E155015`）。知らないと、コミットで止まって理由が分からない。
 *   解き終わる経路は2つある（「競合を解決」の一括と、一覧で選んで書く手動）。どちらもここを通す（ADR-261108-01）。
 */
import * as path from "node:path";
import * as vscode from "vscode";
import { isSubversionWorkingCopy } from "../../core/conflict/subversion";

/**
 * @param message 解き終えたことを伝える文言（l10n 済み）
 * @param filePath 解いたファイルのどれか1つ。作業コピーかどうかをここから判定する
 */
export function withSvnResolveHint(message: string, filePath: string | undefined): string {
	if (!filePath || !isSubversionWorkingCopy(path.dirname(filePath))) {
		return message;
	}
	// 解いたファイルの名前は挙げない。sync が先に畳んだ `unit-state` のように、svn では競合中なのに
	// ここを通らないものがあり、挙げると「挙がっていないものは済んだ」と読まれる。
	// コマンドの `-R .mdait` は省けない。`--accept` を付けると既定の深さが empty になり、
	// パスを省くと何も解決されない（svn 1.14 で実測）
	return vscode.l10n.t(
		"{0} Subversion still marks the conflicted files in .mdait as conflicted: mark them resolved before you commit (TortoiseSVN \"Resolved\", or run svn resolve --accept working -R .mdait at the working copy root).",
		message,
	);
}
