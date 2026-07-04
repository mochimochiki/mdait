/**
 * @file term-extractor.ts
 * @description ユニット内容から用語を抽出し、翻訳コンテキスト用の形式に変換
 */

import { anyTermVariantAppears } from "../../core/term/term-matcher";
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
 * ユニット内容から該当する用語を抽出し、翻訳用の形式に変換
 * @param unitContent ユニットの本文
 * @param allTerms 全用語エントリ
 * @param sourceLang 原文の言語コード
 * @param targetLang 訳文の言語コード
 * @returns 翻訳プロンプトに含める用語リスト
 */
export function extractRelevantTerms(
	unitContent: string,
	allTerms: readonly TermEntry[],
	sourceLang: string,
	targetLang: string,
): TranslationTerm[] {
	const relevantTerms: TranslationTerm[] = [];

	for (const entry of allTerms) {
		// 原語と訳語の両方が存在するかチェック
		const sourceTerm = TermEntryUtils.getTerm(entry, sourceLang);
		const targetTerm = TermEntryUtils.getTerm(entry, targetLang);

		if (!sourceTerm || !targetTerm) {
			continue;
		}

		// ユニット内容に原語またはその表記揺れが含まれるかチェック
		if (isTermRelevant(unitContent, entry, sourceLang)) {
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
