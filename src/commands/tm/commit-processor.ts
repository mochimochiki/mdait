/**
 * @file commit-processor.ts
 * @description
 *   tm-commit処理の中核ロジック。
 *   ユニット単位で primary/local の TM登録計画を生成し、guarded upsert する。
 * @module commands/tm/commit-processor
 */
import { calculateHash } from "../../core/hash/hash-calculator";
import { isWorthyForTm, stripMarkdown } from "../../core/tm/tm-text-normalizer";
import type { TmxStore } from "../../core/tm/tmx-store";
import type { ExistingTmEntriesItem, TmCommitEntry, TmEntry } from "../../core/tm/types";
import { Logger } from "../../utils/logger";
import type { LLMTmEntryGenerator } from "./tm-entry-generator";

const logger = Logger.getInstance();

export interface TmCommitResolvedUnit {
	content: string;
	lang: string;
	unitPath: string;
	unitHash: string;
}

/** TM登録/更新された文ペア（結果プレビュー用） */
export interface TmResultItem {
	primary: string;
	local: string;
}

/** tm-commitの処理結果（ユニット単位） */
export interface TmCommitUnitResult {
	/** 新規登録された文ペア数 */
	newCount: number;
	/** 既存更新された文ペア数 */
	existingCount: number;
	/** スキップされた文ペア数（空文など） */
	skippedCount: number;
	/** warning 件数 */
	warnedCount: number;
	/** 新規登録された文ペア */
	newItems: TmResultItem[];
	/** 更新された文ペア */
	updatedItems: TmResultItem[];
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
	/** warning 件数 */
	warnedEntries: number;
	/** エラーが発生したユニット数 */
	errorUnits: number;
	/** 新規登録された文ペア */
	newItems: TmResultItem[];
	/** 更新された文ペア */
	updatedItems: TmResultItem[];
}

interface GuardResult {
	acceptedNewItems: TmCommitEntry[];
	acceptedUpdateItems: Map<string, TmCommitEntry>;
	unresolvedRequiredTuids: Set<string>;
	invalidReasons: Map<string, string>;
	skippedCount: number;
	warnedCount: number;
}

/**
 * tm-commit処理の中核プロセッサ。
 * ユニット単位でTM登録を行うロジックを提供する。
 */
export class TmCommitProcessor {
	constructor(
		private readonly store: TmxStore,
		private readonly generator: LLMTmEntryGenerator,
		private readonly primaryLang: string,
		private readonly retryLimit = 1,
	) {}

	/**
	 * 単一ユニットを処理してTMに登録する。
	 * @param primaryUnit primary ユニット
	 * @param localUnit local ユニット
	 * @param cancellationToken キャンセルトークン
	 * @returns ユニット単位の処理結果
	 */
	async processUnit(
		primaryUnit: TmCommitResolvedUnit,
		localUnit: TmCommitResolvedUnit,
		cancellationToken?: import("vscode").CancellationToken,
	): Promise<TmCommitUnitResult> {
		const strippedPrimaryUnit = stripMarkdown(primaryUnit.content);
		const strippedLocalUnit = stripMarkdown(localUnit.content);

		const allEntries = this.store.getEntriesByUnitPath(primaryUnit.unitPath, this.primaryLang, localUnit.lang);
		const ExistingTmEntries = this.filterRelevantEntries(
			allEntries,
			strippedPrimaryUnit,
			strippedLocalUnit,
			localUnit.lang,
		);

		const requiredUpdateTuids = this.deriveRequiredUpdateTuids(ExistingTmEntries, localUnit.lang, strippedLocalUnit);

		const pairs = await this.generator.generateEntries(
			{
				primaryLang: this.primaryLang,
				localLang: localUnit.lang,
				primaryUnit: strippedPrimaryUnit,
				localUnit: strippedLocalUnit,
				ExistingTmEntries,
				requiredUpdateTuids,
			},
			cancellationToken,
		);

		if (pairs.length === 0 && requiredUpdateTuids.length === 0) {
			logger.debug("tm.commit", "No sentence pairs from alignment", {
				unitPath: localUnit.unitPath,
			});
			return { newCount: 0, existingCount: 0, skippedCount: 0, warnedCount: 0, newItems: [], updatedItems: [] };
		}

		const existingTmMap = new Map(ExistingTmEntries.map((item) => [item.tuid, item]));
		const acceptedNewItems: TmCommitEntry[] = [];
		const acceptedUpdateItems = new Map<string, TmCommitEntry>();

		let warningCount = 0;
		let skippedCount = 0;

		const initialGuard = this.guardPlanItems(
			pairs,
			strippedPrimaryUnit,
			strippedLocalUnit,
			existingTmMap,
			new Set(requiredUpdateTuids),
			localUnit.lang,
			localUnit.unitPath,
		);
		acceptedNewItems.push(...initialGuard.acceptedNewItems);
		this.mergeAcceptedUpdates(acceptedUpdateItems, initialGuard.acceptedUpdateItems);
		skippedCount += initialGuard.skippedCount;
		warningCount += initialGuard.warnedCount;

		let unresolvedRequiredTuids = initialGuard.unresolvedRequiredTuids;
		let lastInvalidReasons = initialGuard.invalidReasons;

		for (let attempt = 1; attempt <= this.retryLimit && unresolvedRequiredTuids.size > 0; attempt++) {
			const retryItems = await this.generator.generateEntries(
				{
					primaryLang: this.primaryLang,
					localLang: localUnit.lang,
					primaryUnit: strippedPrimaryUnit,
					localUnit: strippedLocalUnit,
					ExistingTmEntries,
					requiredUpdateTuids,
					retryMissingTuids: [...unresolvedRequiredTuids],
					retryReason: this.buildRetryReason(lastInvalidReasons),
				},
				cancellationToken,
			);

			const retryGuard = this.guardPlanItems(
				retryItems,
				strippedPrimaryUnit,
				strippedLocalUnit,
				existingTmMap,
				unresolvedRequiredTuids,
				localUnit.lang,
				localUnit.unitPath,
				true,
			);
			this.mergeAcceptedUpdates(acceptedUpdateItems, retryGuard.acceptedUpdateItems);
			skippedCount += retryGuard.skippedCount;
			warningCount += retryGuard.warnedCount;
			unresolvedRequiredTuids = retryGuard.unresolvedRequiredTuids;
			lastInvalidReasons = retryGuard.invalidReasons;
		}

		if (unresolvedRequiredTuids.size > 0) {
			warningCount += unresolvedRequiredTuids.size;
			for (const tuid of unresolvedRequiredTuids) {
				logger.warn("tm.commit", "Required update unresolved after retries", {
					unitPath: localUnit.unitPath,
					localLang: localUnit.lang,
					tuid,
					attempts: this.retryLimit,
					reason: lastInvalidReasons.get(tuid) ?? "missing required update",
				});
			}
		}

		const mutationResult = this.applyPlanItems(acceptedNewItems, acceptedUpdateItems, primaryUnit, localUnit);

		logger.info("tm.commit", "Unit processing completed", {
			newCount: mutationResult.newCount,
			existingCount: mutationResult.existingCount,
			skippedCount,
			warnedCount: warningCount,
			unitPath: localUnit.unitPath,
		});

		return {
			newCount: mutationResult.newCount,
			existingCount: mutationResult.existingCount,
			skippedCount,
			warnedCount: warningCount,
			newItems: mutationResult.newItems,
			updatedItems: mutationResult.updatedItems,
		};
	}

	/**
	 * existing TM set から update 必須 tuid を導出する。
	 */
	deriveRequiredUpdateTuids(
		ExistingTmEntries: ExistingTmEntriesItem[],
		localLang: string,
		strippedLocalUnit: string,
	): string[] {
		return ExistingTmEntries.filter((item) => {
			const entry = this.store.findByTuid(item.tuid);
			const localVariant = entry?.variants.get(localLang);
			if (!localVariant) {
				return true;
			}
			return !item.localSentence || !strippedLocalUnit.includes(item.localSentence.trim());
		}).map((item) => item.tuid);
	}

	/**
	 * `getEntriesByUnitPath` の全件から、現在の commit コンテキストに関連するエントリのみを抽出する。
	 */
	private filterRelevantEntries(
		allEntries: TmEntry[],
		primaryUnitText: string,
		_localUnitText: string | undefined,
		localLang: string,
	): ExistingTmEntriesItem[] {
		const sentenceCandidates = new Map<string, TmEntry[]>();
		for (const entry of allEntries) {
			if (!primaryUnitText.includes(entry.primary.trim())) continue;
			const key = entry.primary.trim();
			const bucket = sentenceCandidates.get(key) ?? [];
			bucket.push(entry);
			sentenceCandidates.set(key, bucket);
		}

		const results: ExistingTmEntriesItem[] = [];
		for (const candidates of sentenceCandidates.values()) {
			for (const entry of candidates) {
				const localVariant = entry.variants.get(localLang);
				results.push({
					tuid: entry.tuid,
					primarySentence: entry.primary,
					localSentence: localVariant?.text ?? null,
				});
			}
		}

		return results.sort((a, b) => a.tuid.localeCompare(b.tuid));
	}

	private guardPlanItems(
		items: TmCommitEntry[],
		strippedPrimaryUnit: string,
		strippedLocalUnit: string,
		existingTmMap: ReadonlyMap<string, ExistingTmEntriesItem>,
		requiredUpdateTuids: ReadonlySet<string>,
		localLang: string,
		unitPath: string,
		allowOnlyUpdates = false,
	): GuardResult {
		const acceptedNewItems: TmCommitEntry[] = [];
		const acceptedUpdateItems = new Map<string, TmCommitEntry>();
		const unresolvedRequiredTuids = new Set(requiredUpdateTuids);
		const invalidReasons = new Map<string, string>();
		let skippedCount = 0;
		let warnedCount = 0;

		for (const item of items) {
			const validationError = this.validatePlanItem(
				item,
				strippedPrimaryUnit,
				strippedLocalUnit,
				existingTmMap,
				requiredUpdateTuids,
				localLang,
				allowOnlyUpdates,
			);

			if (validationError) {
				skippedCount++;
				if (item.type === "update" && requiredUpdateTuids.has(item.tuid)) {
					invalidReasons.set(item.tuid, validationError);
				} else {
					warnedCount++;
					logger.warn("tm.commit", "TM plan item rejected by guard", {
						unitPath,
						localLang,
						tuid: item.tuid,
						reason: validationError,
					});
				}
				continue;
			}

			if (item.type === "new") {
				acceptedNewItems.push(item);
				continue;
			}

			acceptedUpdateItems.set(item.tuid, item);
			unresolvedRequiredTuids.delete(item.tuid);
		}

		for (const tuid of unresolvedRequiredTuids) {
			if (!invalidReasons.has(tuid)) {
				invalidReasons.set(tuid, "missing required update");
			}
		}

		return {
			acceptedNewItems,
			acceptedUpdateItems,
			unresolvedRequiredTuids: new Set(invalidReasons.keys()),
			invalidReasons,
			skippedCount,
			warnedCount,
		};
	}

	private validatePlanItem(
		item: TmCommitEntry,
		strippedPrimaryUnit: string,
		strippedLocalUnit: string,
		existingTmMap: ReadonlyMap<string, ExistingTmEntriesItem>,
		requiredUpdateTuids: ReadonlySet<string>,
		localLang: string,
		allowOnlyUpdates: boolean,
	): string | null {
		if (allowOnlyUpdates && item.type !== "update") {
			return "retry response must contain update items only";
		}
		if (!item.primary.trim() || !item.local.trim()) {
			return "primary/local must not be empty";
		}
		if (item.primary.includes("\n") || item.local.includes("\n")) {
			return "primary/local must be single-line sentences";
		}
		if (!strippedPrimaryUnit.includes(item.primary) || !strippedLocalUnit.includes(item.local)) {
			return "primary/local must be subset of stripped units";
		}

		if (item.type === "new") {
			if (item.tuid !== "-") {
				return "new item must use placeholder tuid";
			}
			if (!isWorthyForTm(item.primary, this.primaryLang)) {
				return "primary sentence is not worthy for TM";
			}
			return null;
		}

		const existingItem = existingTmMap.get(item.tuid);
		if (!existingItem) {
			return "update item references tuid outside existing TM set";
		}
		if (calculateHash(item.primary, true) !== item.tuid) {
			return "update item primary does not match tuid";
		}
		if (existingItem.primarySentence !== item.primary) {
			return "update item primary does not match existing primary sentence";
		}
		if (!requiredUpdateTuids.has(item.tuid) && existingItem.localSentence === item.local) {
			return "update item is a no-op";
		}
		return null;
	}

	private buildRetryReason(invalidReasons: ReadonlyMap<string, string>): string {
		return [...invalidReasons.entries()].map(([tuid, reason]) => `${tuid}: ${reason}`).join("; ");
	}

	private mergeAcceptedUpdates(target: Map<string, TmCommitEntry>, source: ReadonlyMap<string, TmCommitEntry>): void {
		for (const [tuid, item] of source) {
			target.set(tuid, item);
		}
	}

	private applyPlanItems(
		newItems: readonly TmCommitEntry[],
		updateItems: ReadonlyMap<string, TmCommitEntry>,
		primaryUnit: TmCommitResolvedUnit,
		localUnit: TmCommitResolvedUnit,
	): { newCount: number; existingCount: number; newItems: TmResultItem[]; updatedItems: TmResultItem[] } {
		let newCount = 0;
		let existingCount = 0;
		const resultNewItems: TmResultItem[] = [];
		const resultUpdatedItems: TmResultItem[] = [];
		const dedupedNewItems = new Map<string, TmCommitEntry>();
		for (const item of newItems) {
			dedupedNewItems.set(calculateHash(item.primary, true), item);
		}

		const commitEntry = (tuid: string, primary: string, local: string): void => {
			const existing = this.store.findByTuid(tuid);
			const entry: TmEntry = {
				tuid,
				primary,
				weight: 1,
				variants: new Map([
					[this.primaryLang, { text: primary }],
					[localUnit.lang, { text: local }],
				]),
			};

			this.store.addEntry(entry);
			if (existing) {
				existingCount++;
				resultUpdatedItems.push({ primary, local });
			} else {
				newCount++;
				resultNewItems.push({ primary, local });
			}
		};

		for (const [tuid, item] of dedupedNewItems) {
			commitEntry(tuid, item.primary, item.local);
		}

		for (const item of updateItems.values()) {
			commitEntry(item.tuid, item.primary, item.local);
		}
		return { newCount, existingCount, newItems: resultNewItems, updatedItems: resultUpdatedItems };
	}
}
