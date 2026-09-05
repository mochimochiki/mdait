/**
 * @file tm-reference-formatter.ts
 * @description TM検索結果をプロンプト用にフォーマットするユーティリティ。
 * VS Code非依存のため、Core層に配置。
 */

import type { TmMatch } from "./types";

/**
 * 一致度を百分率の**数**にする（0〜100）。
 *
 * **100 と読めるのは完全一致のときだけ**にする。0.996 を四捨五入して 100 と出すと、
 * 受け取る側は「同じ文だ」と読むが実際は違う文なので、下は切り捨てて 99 で止める。
 *
 * **0〜1 の外にある値はすべて 0 に倒す。** 一致度は Jaccard 係数なので数学的にこの範囲を
 * 出ない。外に出ているということは計算が壊れているということで、NaN も 1.5 も同じ扱いにする。
 * 壊れた値を 100 に倒すと、**壊れたときにいちばん強い合図（同じ文だ）が出てしまう**。
 * 弱いほうへ倒すのが安全な側である。
 */
function formatMatchRate(similarity: number): number {
	if (!Number.isFinite(similarity) || similarity < 0 || similarity > 1) {
		return 0;
	}
	if (similarity === 1) {
		return 100;
	}
	return Math.floor(similarity * 100);
}

/**
 * TM検索結果をプロンプト用にフォーマットする。
 *
 * 各件の先頭に**いま訳している文にどれだけ近いか**を付ける。付けないと、受け取る側は
 * 完全一致と遠い参考を区別できない（実測では、区別が無いまま渡すと近似一致の採用が
 * 回ごとに揺れた）。翻訳の道具では一致度を見て扱いを変えるのが普通の作法でもある。
 *
 * @param matches TM検索結果配列
 * @returns フォーマット済み文字列
 */
export function formatTmReferences(matches: TmMatch[]): string {
	return matches
		.map((m, i) => {
			const from = m.firstUsedIn ? ` (from: ${m.firstUsedIn})` : "";
			return `${i + 1}. [${formatMatchRate(m.similarity)}% match] Source: "${m.source}"\n   Translation: "${m.target}"${from}`;
		})
		.join("\n\n");
}
