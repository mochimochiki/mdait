/**
 * @file tm-commit-processor.ts
 * @description
 *   tm-commit処理の中核ロジック。
 *   ユニット単位でソース/ターゲットの対訳を文アライメントし、TmxStoreに登録する。
 *   将来のfixコマンドからも呼び出し可能な独立設計。
 * @module commands/tm-commit/tm-commit-processor
 */
import { calculateHash } from "../../core/hash/hash-calculator";
import type { TmxStore } from "../../core/tm/tmx-store";
import type { SentencePair, TmEntry, TmUsedIn } from "../../core/tm/types";
import { Logger } from "../../utils/logger";
import type { SentenceAligner } from "./sentence-aligner";

const logger = Logger.getInstance();

/** tm-commitの処理結果（ユニット単位） */
export interface TmCommitUnitResult {
	/** 新規登録された文ペア数 */
	newCount: number;
	/** 既存更新された文ペア数 */
	existingCount: number;
	/** スキップされた文ペア数（空文など） */
	skippedCount: number;
}

/** tm-commitの処理結果（全体） */
export interface TmCommitResult {
	/** 処理されたユニット数 */
	processedUnits: number;
	/** スキップされたユニット数 */
	skippedUnits: number;
	/** 新規登録された文ペア数 */
	newEntries: number;
	/** 既存更新された文ペア数 */
	existingEntries: number;
	/** エラーが発生したユニット数 */
	errorUnits: number;
}

/**
 * tm-commit処理の中核プロセッサ。
 * ユニット単位でTM登録を行うロジックを提供する。
 */
export class TmCommitProcessor {
	constructor(
		private readonly store: TmxStore,
		private readonly aligner: SentenceAligner,
		private readonly sourceLang: string,
		private readonly targetLang: string,
	) {}

	/**
	 * 単一ユニットを処理してTMに登録する。
	 * @param sourceContent ソースユニットの本文
	 * @param targetContent ターゲットユニットの本文
	 * @param unitInfo 出典情報
	 * @param cancellationToken キャンセルトークン
	 * @returns ユニット単位の処理結果
	 */
	async processUnit(
		sourceContent: string,
		targetContent: string,
		unitInfo: TmUsedIn,
		cancellationToken?: import("vscode").CancellationToken,
	): Promise<TmCommitUnitResult> {
		// 文アライメント
		const pairs = await this.aligner.alignSentences(
			sourceContent,
			targetContent,
			this.sourceLang,
			this.targetLang,
			cancellationToken,
		);

		if (pairs.length === 0) {
			logger.debug("tm-commit", "No sentence pairs from alignment", {
				unitPath: unitInfo.unitPath,
			});
			return { newCount: 0, existingCount: 0, skippedCount: 0 };
		}

		return this.registerPairs(pairs, unitInfo);
	}

	/**
	 * 対訳ペア配列をTmxStoreに登録する。
	 * @param pairs 対訳ペア配列
	 * @param unitInfo 出典情報
	 * @returns 登録結果
	 */
	registerPairs(pairs: SentencePair[], unitInfo: TmUsedIn): TmCommitUnitResult {
		let newCount = 0;
		let existingCount = 0;
		let skippedCount = 0;

		for (const pair of pairs) {
			if (!pair.source.trim() || !pair.target.trim()) {
				skippedCount++;
				continue;
			}

			const sentenceHash = calculateHash(pair.source, true);
			const existing = this.store.findByHash(sentenceHash);

			const entry: TmEntry = {
				sentenceHash,
				segments: new Map([
					[this.sourceLang, pair.source],
					[this.targetLang, pair.target],
				]),
				usedIn: [unitInfo],
				createdAt: new Date().toISOString(),
			};

			// addEntryは既存時にセグメント上書き+usedIn追加を行う
			this.store.addEntry(entry);

			if (existing) {
				existingCount++;
			} else {
				newCount++;
			}
		}

		return { newCount, existingCount, skippedCount };
	}
}
