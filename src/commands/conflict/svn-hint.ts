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
 * 何を「解決済み」にさせるか。
 *
 * - `mdait-dir`: `.mdait` の中を丸ごと。一括の解決で、残りの競合がもう無いときだけ使う
 * - `file`: 解いたファイルだけ。手動の解決は1ファイルを書くだけで、ほかのファイルに競合が残っていることがある。
 *   `.mdait` 丸ごとを案内すると、競合マーカーの残ったファイルまで svn の解決済みになり、コミットで止まらなくなる
 */
export type SvnResolveScope = "mdait-dir" | "file";

/**
 * @param message 解き終えたことを伝える文言（l10n 済み）
 * @param filePath 解いたファイルのどれか1つ（`.mdait` の中）。作業コピーかどうかと、案内するパスをここから決める
 * @param scope 何を解決済みにさせるか
 */
export function withSvnResolveHint(message: string, filePath: string | undefined, scope: SvnResolveScope): string {
	if (!filePath || !isSubversionWorkingCopy(path.dirname(filePath))) {
		return message;
	}
	// パスは絶対パスで示す。`.mdait` は作業コピーの根にあるとは限らない（設定はサブフォルダにも置ける）ので、
	// 「根で `.mdait` を」と案内すると別の `.mdait` を操作してしまう。
	// `.mdait` 丸ごとのときは `-R` が要る。`--accept` を付けると既定の深さが empty になり、
	// 何も解決されない（svn 1.14 で実測）
	const command =
		scope === "mdait-dir"
			? `svn resolve --accept working -R "${path.dirname(filePath)}"`
			: `svn resolve --accept working "${filePath}"`;
	return scope === "mdait-dir"
		? vscode.l10n.t(
				"{0} Subversion still marks the conflicted files in .mdait as conflicted: mark them resolved before you commit (TortoiseSVN \"Resolved\", or {1}).",
				message,
				command,
			)
		: vscode.l10n.t(
				"{0} Subversion still marks this file as conflicted: mark it resolved before you commit (TortoiseSVN \"Resolved\", or {1}).",
				message,
				command,
			);
}
