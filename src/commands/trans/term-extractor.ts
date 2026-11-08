/**
 * @file term-extractor.ts
 * @description ユニット内容から用語を抽出し、翻訳コンテキスト用の形式に変換
 */

import { anyTermVariantAppears, stripCodeSegments } from "../../core/term/term-matcher";
import type { TermEntry } from "../term/term-entry";
import { TermEntry as TermEntryUtils } from "../term/term-entry";

/**
 * 翻訳プロンプトに含める用語情報
 */
export interface TranslationTerm {
	/** 原語（sourceLang） */
	term: string;
	/** 訳語（targetLang） */
	translation: string;
	/**
	 * 訳語の表記揺れ（targetLang の variants）。指示文には載せず、訳文の確かめにだけ使う。
	 * variants が無ければ省く
	 */
	translationVariants?: string[];
	/** コンテキスト情報（オプション） */
	context?: string;
}

/**
 * 用語を探す範囲の指定。
 */
export interface TermExtractionOptions {
	/**
	 * 本文を Markdown として扱うか（既定 true）。
	 *
	 * true のときはコードブロックとインラインコードを照合から外す。訳してはいけない場所に
	 * 用語があるだけで「この語はこう訳せ」が指示文に載ってしまうのを防ぐためで、
	 * term-lint・AIレビューの用語抽出と同じ判定になる（ADR-260704-04）。
	 *
	 * 非Markdown の管理下ファイル（.txt / .csv / .json）では false を渡す。
	 * Markdown のコードフェンスの規則を JSON や CSV に当てるのは筋が違うため。
	 */
	markdown?: boolean;
}

/**
 * ユニット内容から該当する用語を抽出し、翻訳用の形式に変換
 * @param unitContent ユニットの本文（生のまま渡してよい。範囲の切り出しはこの関数の中で行う）
 * @param allTerms 全用語エントリ
 * @param sourceLang 原文の言語コード
 * @param targetLang 訳文の言語コード
 * @param options 探す範囲の指定
 * @returns 翻訳プロンプトに含める用語リスト
 */
export function extractRelevantTerms(
	unitContent: string,
	allTerms: readonly TermEntry[],
	sourceLang: string,
	targetLang: string,
	options: TermExtractionOptions = {},
): TranslationTerm[] {
	// 照合の範囲は用語ごとではなく**一度だけ**切り出す（用語数ぶん繰り返さない）
	const haystack = options.markdown === false ? unitContent : stripCodeSegments(unitContent);
	const relevantTerms: TranslationTerm[] = [];

	for (const entry of allTerms) {
		// 原語と訳語の両方が存在するかチェック
		const sourceTerm = TermEntryUtils.getTerm(entry, sourceLang);
		const targetTerm = TermEntryUtils.getTerm(entry, targetLang);

		if (!sourceTerm || !targetTerm) {
			continue;
		}

		// ユニット内容に原語またはその表記揺れが含まれるかチェック
		if (isTermRelevant(haystack, entry, sourceLang)) {
			const translationVariants = [...TermEntryUtils.getvariants(entry, targetLang)];
			relevantTerms.push({
				term: sourceTerm,
				translation: targetTerm,
				context: entry.context || undefined,
				...(translationVariants.length > 0 ? { translationVariants } : {}),
			});
		}
	}

	return relevantTerms;
}

/**
 * ユニット内容に用語（またはvariants）が含まれるかチェック
 * @param content ユニット内容
 * @param entry 用語エントリ
 * @param lang 言語コード
 * @returns 含まれる場合true
 */
function isTermRelevant(content: string, entry: TermEntry, lang: string): boolean {
	const term = TermEntryUtils.getTerm(entry, lang);
	if (!term) {
		return false;
	}

	// 照合ロジックは core/term/term-matcher に共通化（term-lint と同一の判定）
	return anyTermVariantAppears(content, term, TermEntryUtils.getvariants(entry, lang));
}

/**
 * 訳し分けのある語に添える指示。`senses` を持つ語が1つでもあるときだけ、JSON の後ろに付ける。
 *
 * 指示文（system）の規則には書かない。訳し分けの無い用語集では、指示文が1文字も
 * 変わらないようにするため（録音による回帰がそのまま通り、既存の利用者の指示文も動かない）。
 */
export const TERM_SENSES_NOTE =
	'Terms with "senses" take a different translation depending on their meaning. For each occurrence, use the translation whose "when" matches that occurrence, and never use a sense whose "when" does not match.';

/**
 * 用語リストをプロンプトに埋め込む文字列に変換する。
 *
 * 同じ原語の行が複数あるとき（訳し分け。ADR-261108-06）は、1つの語にまとめて
 * `senses` の配列にする。各行の context は「どの意味のときにこの訳語を使うか」として
 * `when` に載せる。並べたまま渡すと、同じ語に「strictly に従え」という訳語が2つ並び、
 * どちらを使うかの手がかりが無くなる。
 *
 * 訳し分けの無い語は、これまでと同じ `{term, translation, context}` の形のまま。
 *
 * @param terms 用語リスト
 * @returns JSON文字列（整形済み）。訳し分けのある語があれば、後ろに `TERM_SENSES_NOTE` が続く
 */
export function termsToJson(terms: TranslationTerm[]): string {
	if (terms.length === 0) {
		return "";
	}

	const groups = groupBySourceTerm(terms);
	const compactTerms = groups.map((group) => {
		if (group.length === 1) {
			// contextが空の場合は省略してコンパクトに
			const [t] = group;
			const result: Record<string, string> = {
				term: t.term,
				translation: t.translation,
			};
			if (t.context) {
				result.context = t.context;
			}
			return result;
		}
		return {
			term: group[0].term,
			senses: group.map((t) => (t.context ? { translation: t.translation, when: t.context } : { translation: t.translation })),
		};
	});

	const json = JSON.stringify(compactTerms, null, 2);
	return groups.some((group) => group.length > 1) ? `${json}\n${TERM_SENSES_NOTE}` : json;
}

/**
 * 原語ごとにまとめる。並びは最初に出てきた順で、同じ訳語の行は1つに畳む
 * （同じ訳語を2度並べても選ぶ手がかりは増えない）。
 */
export function groupBySourceTerm(terms: readonly TranslationTerm[]): TranslationTerm[][] {
	const groups = new Map<string, TranslationTerm[]>();
	for (const term of terms) {
		const group = groups.get(term.term);
		if (!group) {
			groups.set(term.term, [term]);
		} else if (!group.some((existing) => existing.translation === term.translation)) {
			group.push(term);
		}
	}
	return [...groups.values()];
}
