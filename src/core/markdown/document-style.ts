/**
 * @file document-style.ts
 * @description
 *   原稿の「書式のくせ」— 改行コードと末尾改行の有無 — を測って復元する純関数。
 *
 *   `markdownParser.stringify` はどんな原稿からでも LF 連結・末尾改行1つで書き出す。
 *   これは組み立ての都合であって、原稿の姿ではない。Windows で書かれた（CRLF の）訳文は
 *   sync のたびに全行 LF へ書き換えられ、**内容が1文字も変わっていないのにファイル全体が
 *   差分になっていた**（実測。sync の集計は added/modified とも 0 のまま）。
 *
 *   書き出しの直前でここを通し、元の姿へ戻す。新しく作るファイルには LF と末尾改行を使う。
 * @module core/markdown/document-style
 */

/** 原稿の書式のくせ */
export interface DocumentStyle {
	/** 改行コード */
	eol: "\n" | "\r\n";
	/** 末尾に改行があるか */
	endsWithNewline: boolean;
}

/** 新しく作るファイルの書式（LF・末尾改行あり） */
export const DEFAULT_DOCUMENT_STYLE: DocumentStyle = { eol: "\n", endsWithNewline: true };

/**
 * 元の内容から書式のくせを測る。
 *
 * **多数派の改行コードを採る。** 混在した原稿を少数派の側へ倒すと、そのファイルは全行
 * 書き換えになる。多数派へ倒せば、書き換わるのは少数派だった数行で済む。
 *
 * かつては「1つでも CRLF なら CRLF」と測っていた。CRLF が多数派のときは正しいが、
 * **LF の訳文に CRLF の行が1つ混ざるとファイル全体が CRLF へ倒れる** — Windows の
 * エディタや貼り付けでふつうに起きる。実測では20行の訳文の差分が `+2/-1` から
 * `+20/-19` になり、他人のどの編集ともぶつかる形になっていた。
 *
 * 同数なら LF を採る（新しく作るファイルと同じ側）。
 *
 * @param original 元のファイルの内容。ファイルが無いときは undefined
 */
export function detectDocumentStyle(original: string | undefined): DocumentStyle {
	if (original === undefined || original === "") {
		return DEFAULT_DOCUMENT_STYLE;
	}
	const crlfCount = (original.match(/\r\n/g) ?? []).length;
	const lfCount = (original.match(/\n/g) ?? []).length - crlfCount;
	return {
		eol: crlfCount > lfCount ? "\r\n" : "\n",
		endsWithNewline: /\n$/.test(original),
	};
}

/**
 * 書き出す内容を、測った書式へ揃える。
 *
 * 入力は `stringify` の出力（LF・末尾改行あり）を想定するが、CRLF が混ざっていても
 * いったん LF へ均してから揃えるので、二重の `\r` は生まれない。
 */
export function applyDocumentStyle(content: string, style: DocumentStyle): string {
	const normalized = content.replace(/\r\n/g, "\n");
	const body = style.endsWithNewline ? normalized : normalized.replace(/\n+$/, "");
	return style.eol === "\r\n" ? body.replace(/\n/g, "\r\n") : body;
}
