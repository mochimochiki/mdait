import type { FrontMatter } from "./front-matter";
import type { MdaitUnit } from "./mdait-unit";

export interface Markdown {
	frontMatter?: FrontMatter;
	units: MdaitUnit[];
	/**
	 * frontmatter の閉じ `---` と本文の先頭のあいだにある空行の数。
	 *
	 * 静的サイトの原稿は空行を1つ置く書き方が多い。書き出しのときにこれを再現しないと、
	 * 内容が1文字も変わっていないのに全ファイルが差分になる（ADR-260903-02）。
	 * 未指定は 0（空行なし）— 新しく組み立てた文書の既定。
	 */
	frontMatterGap?: number;
}
