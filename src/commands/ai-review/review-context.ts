/**
 * @file review-context.ts
 * @description
 *   AIペアリング検証に注入する用語集・TM参照の収集。
 *   ファイル単位で1回だけ用語集ロード（TermsCacheManager）と TmxStore 取得を行い、
 *   ペア毎に双方向抽出・双方向TM検索（同期・純計算）を提供する。
 *   訳揺れ検知のため、原文・訳文どちらかにヒットしたものをすべて注入する。
 * @module commands/ai-review/review-context
 */

import * as path from "node:path";
import { searchTmBidirectional } from "../../core/tm/tm-line-search";
import { formatTmReferences } from "../../core/tm/tm-reference-formatter";
import { TmxStore } from "../../core/tm/tmx-store";
import type { Configuration } from "../../infra/config/configuration";
import type { TermEntry } from "../term/term-entry";
import { termsToJson } from "../trans/term-extractor";
import { TermsCacheManager } from "../trans/terms-cache-manager";
import { extractBidirectionalTerms } from "./review-term-extractor";

/** 1ペア分の検証コンテキスト（該当なしの項目は undefined） */
export interface PairReviewContext {
	/** 用語集 JSON（termsToJson の出力） */
	termsJson?: string;
	/** TM参照（formatTmReferences の出力） */
	tmReferences?: string;
}

/**
 * レビュー用コンテキストプロバイダ。
 * create() でファイル単位のロードを済ませ、getContextForPair() はペア毎の純計算のみ行う。
 */
export class ReviewContextProvider {
	private constructor(
		private readonly terms: readonly TermEntry[],
		private readonly tmStore: TmxStore | undefined,
		private readonly sourceLang: string,
		private readonly targetLang: string,
		private readonly tmOptions: { minQueryLength: number; maxReferences: number },
		private readonly trigramCache: ReadonlyMap<string, ReadonlySet<string>> | undefined,
	) {}

	/**
	 * ファイル単位の初期化。用語集は TermsCacheManager（mtime キャッシュ・ファイル無し→[]）、
	 * TM は tm.enabled false またはエントリ0件なら無効として扱う
	 * （trans の lookupTmReferences と同じガード・同じパス導出）。
	 */
	static async create(config: Configuration, sourceLang: string, targetLang: string): Promise<ReviewContextProvider> {
		const terms = await TermsCacheManager.getInstance().getTerms(config.getTermsFilePath(), config.transPairs);

		let tmStore: TmxStore | undefined;
		if (config.getTmEnabled()) {
			const store = TmxStore.getInstance(path.join(config.getMdaitDir(), "translations.tmx"));
			if (store.getEntryCount() > 0) {
				tmStore = store;
			}
		}

		return new ReviewContextProvider(
			terms,
			tmStore,
			sourceLang,
			targetLang,
			{
				minQueryLength: config.getTmMinQueryLength(),
				maxReferences: config.getTmMaxReferences(),
			},
			tmStore?.getTrigramCache(),
		);
	}

	/**
	 * ペア毎の用語集・TM参照を取得する。
	 * 原文・訳文どちらかにヒットしたエントリをすべて返す（訳揺れ検知の材料）。
	 */
	getContextForPair(sourceText: string, targetText: string): PairReviewContext {
		const context: PairReviewContext = {};

		const relevantTerms = extractBidirectionalTerms(
			sourceText,
			targetText,
			this.terms,
			this.sourceLang,
			this.targetLang,
		);
		if (relevantTerms.length > 0) {
			context.termsJson = termsToJson(relevantTerms);
		}

		if (this.tmStore) {
			const matches = searchTmBidirectional(sourceText, targetText, this.tmStore, {
				minQueryLength: this.tmOptions.minQueryLength,
				maxReferences: this.tmOptions.maxReferences,
				sourceLang: this.sourceLang,
				targetLang: this.targetLang,
				trigramCache: this.trigramCache,
			});
			if (matches.length > 0) {
				context.tmReferences = formatTmReferences(matches);
			}
		}

		return context;
	}
}
