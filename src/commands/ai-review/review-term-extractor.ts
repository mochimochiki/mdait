/**
 * @file review-term-extractor.ts
 * @description
 *   AI翻訳レビュー用の用語抽出。原文・訳文のどちらかに用語（正規形＋variants）が
 *   出現するエントリをすべて抽出する。片側だけのヒットは「訳語不使用」や「別訳語の混入」
 *   （訳揺れ）の兆候であり、判定は用語集を受け取った LLM に委ねる。
 *   VS Code API 非依存。
 * @module commands/ai-review/review-term-extractor
 */

import { anyTermVariantAppears, stripCodeSegments } from "../../core/term/term-matcher";
import type { TermEntry } from "../term/term-entry";
import { TermEntry as TermEntryUtils } from "../term/term-entry";
import type { TranslationTerm } from "../trans/term-extractor";

/**
 * 原文・訳文のどちらかにヒットした用語エントリを抽出する。
 *
 * - 原文側: sourceLang の用語（＋variants）が原文に出現
 * - 訳文側: targetLang の訳語（＋variants）が訳文に出現
 * - 両テキストともコードセグメント除去後に照合する（term-lint と同じ偽陽性対策）
 *
 * @param sourceContent 原文ユニット本文
 * @param targetContent 訳文ユニット本文
 * @param allTerms 全用語エントリ
 * @param sourceLang 原文の言語コード
 * @param targetLang 訳文の言語コード
 * @returns 検証プロンプトに含める用語リスト
 */
export function extractBidirectionalTerms(
	sourceContent: string,
	targetContent: string,
	allTerms: readonly TermEntry[],
	sourceLang: string,
	targetLang: string,
): TranslationTerm[] {
	if (allTerms.length === 0) {
		return [];
	}
	const strippedSource = stripCodeSegments(sourceContent);
	const strippedTarget = stripCodeSegments(targetContent);

	const relevantTerms: TranslationTerm[] = [];
	for (const entry of allTerms) {
		const sourceTerm = TermEntryUtils.getTerm(entry, sourceLang);
		const targetTerm = TermEntryUtils.getTerm(entry, targetLang);
		if (!sourceTerm || !targetTerm) {
			continue;
		}

		const hit =
			anyTermVariantAppears(strippedSource, sourceTerm, TermEntryUtils.getvariants(entry, sourceLang)) ||
			anyTermVariantAppears(strippedTarget, targetTerm, TermEntryUtils.getvariants(entry, targetLang));
		if (hit) {
			relevantTerms.push({
				term: sourceTerm,
				translation: targetTerm,
				context: entry.context || undefined,
			});
		}
	}
	return relevantTerms;
}
