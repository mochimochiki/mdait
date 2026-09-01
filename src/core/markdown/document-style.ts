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
 * **改行が1つでも CRLF なら CRLF とみなす。** 混在した原稿（手で直したところだけ LF など）を
 * LF 側へ倒すと、そのファイルは全行書き換えになる。CRLF 側へ倒せば、書き換わるのは
 * もともと LF だった数行で済む。
 *
 * @param original 元のファイルの内容。ファイルが無いときは undefined
 */
export function detectDocumentStyle(original: string | undefined): DocumentStyle {
	if (original === undefined || original === "") {
		return DEFAULT_DOCUMENT_STYLE;
	}
	return {
		eol: original.includes("\r\n") ? "\r\n" : "\n",
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
