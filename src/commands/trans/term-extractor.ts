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
			relevantTerms.push({
				term: sourceTerm,
				translation: targetTerm,
				context: entry.context || undefined,
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
 * 用語リストをJSON文字列に変換（プロンプト埋め込み用）
 * @param terms 用語リスト
 * @returns JSON文字列（整形済み）
 */
export function termsToJson(terms: TranslationTerm[]): string {
	if (terms.length === 0) {
		return "";
	}

	// contextが空の場合は省略してコンパクトに
	const compactTerms = terms.map((t) => {
		const result: Record<string, string> = {
			term: t.term,
			translation: t.translation,
		};
		if (t.context) {
			result.context = t.context;
		}
		return result;
	});

	return JSON.stringify(compactTerms, null, 2);
}
