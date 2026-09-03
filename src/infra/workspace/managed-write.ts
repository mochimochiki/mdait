/**
 * @file managed-write.ts
 * @description
 *   管理下の原稿（訳文・原文のファイル本体）を書き出す**唯一の入口**。Markdown も、
 *   Markdown 以外の管理下ファイル（.txt / .csv / .json）も同じ扱いにする — 原稿を預ける
 *   相手にとって、拡張子は「勝手に書き換わった」かどうかと何の関係もない。
 *
 *   ここを通す理由は2つある。
 *
 *   1. **原稿の書式のくせを保つ。** `stringify` は LF 連結・末尾改行1つで書き出すので、
 *      Windows で書かれた（CRLF の）原稿は sync のたびに全行 LF へ書き換わっていた。
 *      内容が1文字も変わらなくてもファイル全体が差分になる（実測）。
 *   2. **出来上がりが同じなら書かない。** 保存イベントを無駄に起こさない（`autoSyncOnSave`
 *      が空回りする）。書式を保つようになって初めて、この比較が意味を持つようになった
 *      — 以前は正規化のせいで CRLF の原稿が毎回「変わった」と答えていた。
 *
 *   書き手ごとに同じ処理を書くと必ず取りこぼすので、**新しい書き出し口はここへ足すこと**。
 *   例外は2つ。`.mdait/` の中（`unit-state` などの管理ファイル）は原稿ではない。もう1つは
 *   **まだ無いファイルへ原文をそのまま複製する経路**で、そこはここを通してはいけない
 *   — ディスクに何も無いと書式は既定（LF）と測られるので、CRLF の原文が LF へ倒れる。
 *   複製は素の書き込みでバイト列を写すのが正しい（`plain-file-handler.syncNew`）。
 * @module infra/workspace/managed-write
 */
import * as fs from "node:fs"; // @important Node.jsのbuilt-inモジュールのimportでは`node:`を使用
import * as vscode from "vscode";
import { type DocumentStyle, applyDocumentStyle, detectDocumentStyle } from "../../core/markdown/document-style";

/** 書き出す内容を、ディスク上の原稿の書式へ揃える。同じなら書かないことも決める */
function prepare(absPath: string, content: string): { styled: string; skip: boolean; style: DocumentStyle } {
	let original: string | undefined;
	try {
		original = fs.readFileSync(absPath, "utf-8");
	} catch (error) {
		// **「読めない」を「無い」と同じに扱わない。** 権限や I/O の失敗まで握りつぶすと、
		// 中身を確かめられなかったファイルを既定の書式で上書きしてしまう（改行のくせも失う）。
		// 無いときだけ新規として進み、それ以外は呼び手へ返す
		if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
			throw error;
		}
	}
	const style = detectDocumentStyle(original);
	const styled = applyDocumentStyle(content, style);
	return { styled, skip: original === styled, style };
}

/**
 * 管理下の原稿を書き出す（VS Code のファイルシステム経由）。
 *
 * @returns 実際に書いたら true、内容が同じで見送ったら false
 */
export async function writeManagedDocument(absPath: string, content: string): Promise<boolean> {
	const { styled, skip } = prepare(absPath, content);
	if (skip) {
		return false;
	}
	await vscode.workspace.fs.writeFile(vscode.Uri.file(absPath), new TextEncoder().encode(styled));
	return true;
}

/**
 * 管理下の原稿を書き出す（同期版）。マーカーの引っ越しなど、同期処理の中から呼ぶ経路用。
 *
 * @returns 実際に書いたら true、内容が同じで見送ったら false
 */
export function writeManagedDocumentSync(absPath: string, content: string): boolean {
	const { styled, skip } = prepare(absPath, content);
	if (skip) {
		return false;
	}
	fs.writeFileSync(absPath, styled, "utf-8");
	return true;
}
