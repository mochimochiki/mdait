/**
 * @file commit-processor.ts
 * @description
 *   tm-commit処理の中核ロジック。
 *   ユニット単位で primary/local の TM登録計画を生成し、guarded upsert する。
 * @module commands/tm/commit-processor
 */
import { calculateHash } from "../../core/hash/hash-calculator";
import { SentenceSplitter } from "../../core/tm/sentence-splitter";
import { isWorthyForTm, stripMarkdown } from "../../core/tm/tm-text-normalizer";
import type { TmxStore } from "../../core/tm/tmx-store";
import type { ExistingTmSetItem, TmCommitPlanItem, TmEntry } from "../../core/tm/types";
import { Logger } from "../../utils/logger";
import type { TmEntryGenerator } from "./tm-entry-generator";

const logger = Logger.getInstance();
const sentenceSplitter = new SentenceSplitter();

export interface TmCommitResolvedUnit {
	content: string;
	lang: string;
	unitPath: string;
	unitHash: string;
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
}

interface GuardResult {
	acceptedNewItems: TmCommitPlanItem[];
	acceptedUpdateItems: Map<string, TmCommitPlanItem>;
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
		private readonly generator: TmEntryGenerator,
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

		const existingTmSet = this.store.getExistingTmSet(
			strippedPrimaryUnit,
			this.primaryLang,
			localUnit.lang,
			primaryUnit.unitPath,
			primaryUnit.unitHash,
			strippedLocalUnit,
			localUnit.unitPath,
			localUnit.unitHash,
		);
		const requiredUpdateTuids = this.deriveRequiredUpdateTuids(
			existingTmSet,
			localUnit.lang,
			localUnit.unitHash,
			strippedLocalUnit,
		);

		const pairs = await this.generator.generateEntries(
			{
				primaryLang: this.primaryLang,
				localLang: localUnit.lang,
				primaryUnit: strippedPrimaryUnit,
				localUnit: strippedLocalUnit,
				existingTmSet,
				requiredUpdateTuids,
			},
			cancellationToken,
		);

		if (pairs.length === 0 && requiredUpdateTuids.length === 0) {
			logger.debug("tm.commit", "No sentence pairs from alignment", {
				unitPath: localUnit.unitPath,
			});
			return { newCount: 0, existingCount: 0, skippedCount: 0, warnedCount: 0 };
		}

		const existingTmMap = new Map(existingTmSet.map((item) => [item.tuid, item]));
		const acceptedNewItems: TmCommitPlanItem[] = [];
		const acceptedUpdateItems = new Map<string, TmCommitPlanItem>();

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
					existingTmSet,
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
		};
	}
	/**
	 * existing TM set から update 必須 tuid を導出する。
	 */
	deriveRequiredUpdateTuids(
		existingTmSet: ExistingTmSetItem[],
		localLang: string,
		localUnitHash: string,
		strippedLocalUnit: string,
	): string[] {
		const currentLocalSentences = new Set(
			sentenceSplitter
				.split(strippedLocalUnit, localLang)
				.map((sentence) => sentence.trim())
				.filter((sentence) => sentence.length > 0),
		);

		return existingTmSet
			.filter((item) => {
				const entry = this.store.findByTuid(item.tuid);
				const localVariant = entry?.variants.get(localLang);
				if (!localVariant) {
					return true;
				}
				if (item.localSentence && currentLocalSentences.has(item.localSentence.trim())) {
					return false;
				}
				return !localUnitHash || localVariant.unitHash !== localUnitHash;
			})
			.map((item) => item.tuid);
	}

	private guardPlanItems(
		items: TmCommitPlanItem[],
		strippedPrimaryUnit: string,
		strippedLocalUnit: string,
		existingTmMap: ReadonlyMap<string, ExistingTmSetItem>,
		requiredUpdateTuids: ReadonlySet<string>,
		localLang: string,
		unitPath: string,
		allowOnlyUpdates = false,
	): GuardResult {
		const acceptedNewItems: TmCommitPlanItem[] = [];
		const acceptedUpdateItems = new Map<string, TmCommitPlanItem>();
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
		item: TmCommitPlanItem,
		strippedPrimaryUnit: string,
		strippedLocalUnit: string,
		existingTmMap: ReadonlyMap<string, ExistingTmSetItem>,
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
		if (!this.isSingleSentence(item.primary, this.primaryLang) || !this.isSingleSentence(item.local, localLang)) {
			return "primary/local must be single sentences";
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

	private isSingleSentence(text: string, lang: string): boolean {
		return sentenceSplitter.split(text, lang).length === 1;
	}

	private buildRetryReason(invalidReasons: ReadonlyMap<string, string>): string {
		return [...invalidReasons.entries()].map(([tuid, reason]) => `${tuid}: ${reason}`).join("; ");
	}

	private mergeAcceptedUpdates(
		target: Map<string, TmCommitPlanItem>,
		source: ReadonlyMap<string, TmCommitPlanItem>,
	): void {
		for (const [tuid, item] of source) {
			target.set(tuid, item);
		}
	}

	private applyPlanItems(
		newItems: readonly TmCommitPlanItem[],
		updateItems: ReadonlyMap<string, TmCommitPlanItem>,
		primaryUnit: TmCommitResolvedUnit,
		localUnit: TmCommitResolvedUnit,
	): { newCount: number; existingCount: number } {
		let newCount = 0;
		let existingCount = 0;
		const dedupedNewItems = new Map<string, TmCommitPlanItem>();
		for (const item of newItems) {
			dedupedNewItems.set(calculateHash(item.primary, true), item);
		}

		const commitEntry = (tuid: string, primary: string, local: string): void => {
			const existing = this.store.findByTuid(tuid);
			const entry: TmEntry = {
				tuid,
				primary,
				variants: new Map([
					[this.primaryLang, { text: primary, unitPath: primaryUnit.unitPath, unitHash: primaryUnit.unitHash }],
					[localUnit.lang, { text: local, unitPath: localUnit.unitPath, unitHash: localUnit.unitHash }],
				]),
			};

			this.store.addEntry(entry);
			if (existing) {
				existingCount++;
			} else {
				newCount++;
			}
		};

		for (const [tuid, item] of dedupedNewItems) {
			commitEntry(tuid, item.primary, item.local);
		}

		for (const item of updateItems.values()) {
			commitEntry(item.tuid, item.primary, item.local);
		}
		return { newCount, existingCount };
	}
}
