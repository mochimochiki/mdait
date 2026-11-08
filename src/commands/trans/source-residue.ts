/**
 * @file source-residue.ts
 * @description
 *   訳文に原文（日本語）が訳されないまま残っていないかを調べる純関数。
 *   trans の品質チェックと mdait_validate の両方から呼ぶ。判定は VS Code API に依存せず、
 *   人に見せる文言（`formatSourceResidueReason`）だけが l10n を通す。
 *
 *   日本語から中国語へ訳すと、AI が一部を訳し忘れても漢字が共通するため見た目で気づきにくい
 *   （実測: Haiku が「本章では，」「| 症状 | 考えられる原因 | 対処 |」を原文のまま返した）。
 *   漢字だけの語は中国語と区別できないので、手がかりは**仮名だけ**に絞る。
 *   仮名は日本語にしか無く、日本語以外の訳文に出れば訳し残しとみなしてよい。
 * @module commands/trans/source-residue
 */
import * as vscode from "vscode";
import { stripCodeSegments } from "../../core/term/term-matcher";

/** 調べた結果 */
export interface SourceResidueResult {
	/** 訳し残しが見つかったか */
	found: boolean;
	/** 見つかった箇所の抜き出し（重複を除き、先頭から最大 MAX_FRAGMENTS 件） */
	fragments: string[];
}

/** 抜き出しを何件まで返すか。人が見て状況をつかめれば足りる */
const MAX_FRAGMENTS = 5;

/**
 * 仮名1文字。
 *
 * 中点「・」（U+30FB）と長音符「ー」（U+30FC）は入れない。中点は中国語でも人名の区切りに使い、
 * 長音符はダッシュの代わりに打たれることがあるので、単独で出ても日本語の手がかりにならない。
 * 半角カナも入れる（U+FF66〜U+FF6F・U+FF71〜U+FF9D。半角の長音符 U+FF70 は除く）。
 */
const KANA =
	"\\u3041-\\u3096\\u309D-\\u309F\\u30A1-\\u30FA\\u30FD-\\u30FF\\u31F0-\\u31FF\\uFF66-\\uFF6F\\uFF71-\\uFF9D";

/** 抜き出しに含める文字（仮名・漢字・長音符・々） */
const WORD = `${KANA}\\u30FC\\u3005\\p{Script=Han}`;

/** 仮名を1つ以上含む、漢字かな交じりの連なり */
const RESIDUE_FRAGMENT = new RegExp(`[${WORD}]*[${KANA}][${WORD}]*`, "gu");

/**
 * 言語コードの先頭（"ja-JP" → "ja"、"zh-hans" → "zh"）を小文字で返す。
 */
function baseLanguage(lang: string): string {
	return lang.toLowerCase().split(/[-_]/)[0];
}

/**
 * 訳し残しを調べるべき言語の組か。
 *
 * 原文が日本語で、訳文が日本語以外のときだけ調べる。訳文も日本語なら仮名があって当然で、
 * 原文が日本語でなければ仮名は訳し残しの手がかりにならない。
 */
export function shouldCheckSourceResidue(sourceLang: string, targetLang: string): boolean {
	return baseLanguage(sourceLang) === "ja" && baseLanguage(targetLang) !== "ja";
}

/**
 * 訳文のうち、訳す対象ではない部分を取り除く。
 *
 * - コードブロック・インラインコード（用語照合と同じ `stripCodeSegments`）
 * - HTML コメント（mdait のマーカーを含む）と HTML タグ・自動リンク
 * - リンクと画像の行き先 `](...)`、参照リンクの定義行
 * - URL
 */
function stripNonProse(text: string): string {
	return stripCodeSegments(text)
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<[^>\n]*>/g, "")
		.replace(/\]\([^)\n]*\)/g, "]")
		.replace(/^\s{0,3}\[[^\]\n]+\]:.*$/gm, "")
		.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "");
}

/**
 * 訳文に原文の仮名が残っていないかを調べる。
 *
 * @param sourceLang 原文の言語
 * @param targetLang 訳文の言語
 * @param translatedText 訳文（生テキスト。マーカーやコードを含んでよい）
 * @param allowedTerms 訳文に仮名のまま出てよい語。用語集の訳語（製品名など、訳さないと決めた語）を渡す。
 *   仮名を含まない語は渡しても結果に影響しない
 */
export function findSourceResidue(
	sourceLang: string,
	targetLang: string,
	translatedText: string,
	allowedTerms: readonly string[] = [],
): SourceResidueResult {
	if (!shouldCheckSourceResidue(sourceLang, targetLang)) {
		return { found: false, fragments: [] };
	}

	let prose = stripNonProse(translatedText);
	// 長い語から外す。短い語を先に外すと、それを含む長い語が途中で切れて一致しなくなる
	const allowed = [...new Set(allowedTerms.filter((term) => term.length > 0))].sort((a, b) => b.length - a.length);
	for (const term of allowed) {
		prose = prose.split(term).join(" ");
	}

	const fragments: string[] = [];
	for (const match of prose.matchAll(RESIDUE_FRAGMENT)) {
		const fragment = match[0];
		if (!fragments.includes(fragment)) {
			fragments.push(fragment);
			if (fragments.length >= MAX_FRAGMENTS) {
				break;
			}
		}
	}
	return { found: fragments.length > 0, fragments };
}

/**
 * 訳し残しを人に伝える文言（確認推奨の理由・validate の違反）を組み立てる。
 */
export function formatSourceResidueReason(fragments: readonly string[]): string {
	return vscode.l10n.t(
		"Untranslated source text may remain (Japanese kana found): {0}",
		fragments.map((fragment) => `「${fragment}」`).join(", "),
	);
}
