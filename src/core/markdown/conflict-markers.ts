import { getCodeBlockLineSet } from "./code-block-lines";

/**
 * バージョン管理の合流が残す競合マーカーの行か。
 *
 * `<<<<<<<` / `|||||||` / `=======` / `>>>>>>>` の**7文字ちょうど**で始まり、そのあとが
 * 行末か空白であること。7文字を数えるのは、Markdown の見出しの下線（`=====`）や区切り線と
 * 取り違えないためである。`>>>>>>>` は引用の入れ子と形が同じなので、後ろに名札
 * （`<<<<<<< .mine` の `.mine`）が無い場合でも7文字ちょうどであることに頼る。
 */
function isMarkerLine(line: string): boolean {
	return /^(<{7}|\|{7}|={7}|>{7})(\s|$)/.test(line);
}

/**
 * 原稿が合流の途中（競合マーカーが入ったまま）かどうか。
 *
 * **コードブロックの中は数えない。** マーカーの書き方を解説する原稿や、競合の直し方を
 * 説明する文書はコードブロックに実例を載せる。そこを拾うと、正常な原稿が永久に
 * 同期されなくなる（同じ考え方でマーカー境界の探索も `getCodeBlockLineSet` を通す）。
 *
 * 「片側だけある」ことも競合とみなす。マーカーを手で消し始めて途中でやめた原稿は、
 * 本文としては壊れており、そのまま hash を取ると訳文へその姿が写る。
 */
export function hasConflictMarkers(content: string): boolean {
	if (!/^(<{7}|\|{7}|={7}|>{7})(\s|$)/m.test(content)) {
		// ほとんどの原稿はここで抜ける（行に切る前に1回で判定する）
		return false;
	}
	const codeBlockLines = getCodeBlockLineSet(content);
	const lines = content.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		if (!codeBlockLines.has(i) && isMarkerLine(lines[i])) {
			return true;
		}
	}
	return false;
}
