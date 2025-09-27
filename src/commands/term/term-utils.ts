/**
 * @file term-utils.ts
 * @description 用語集関連の共通ユーティリティ関数
 */

import type { TransPair } from "../../config/configuration";

/**
 * TransPairから言語リストを抽出する共通ユーティリティ
 * transPairの順序を保持し、source → target の順で言語を配列に格納
 */
export function extractLanguagesFromTransPairs(transPairs: readonly TransPair[]): string[] {
	const languageOrder: string[] = [];
	const seen = new Set<string>();

	for (const pair of transPairs) {
		// source言語を先に追加
		if (pair.sourceLang && !seen.has(pair.sourceLang)) {
			languageOrder.push(pair.sourceLang);
			seen.add(pair.sourceLang);
		}
		// target言語を後に追加
		if (pair.targetLang && !seen.has(pair.targetLang)) {
			languageOrder.push(pair.targetLang);
			seen.add(pair.targetLang);
		}
	}

	return languageOrder;
}
