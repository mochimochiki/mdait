import { normalizeText } from "../hash/normalizer";
import { containsWholeText } from "./tm-text-matcher";
import { stripMarkdown } from "./tm-text-normalizer";
import type { TmxStore } from "./tmx-store";
import type { CurrentPrimaryUnit } from "./types";

export interface TranslationMemoryCleanupResult {
	candidateCount: number;
	deletedTuids: string[];
	keptTuids: string[];
}

export class TranslationMemoryCleanupService {
	constructor(
		private readonly repository: TmxStore,
		private readonly primaryLang: string,
	) {}

	cleanup(currentPrimaryUnits: readonly CurrentPrimaryUnit[]): TranslationMemoryCleanupResult {
		if (!this.primaryLang) {
			return { candidateCount: 0, deletedTuids: [], keptTuids: [] };
		}

		const currentPrimaryUnitHashes = new Set(
			currentPrimaryUnits.map((unit) => unit.unitHash).filter((unitHash) => unitHash.length > 0),
		);
		const candidates = this.repository.findCleanupCandidatesByMissingPrimaryUnitHash(currentPrimaryUnitHashes);
		if (candidates.length === 0) {
			return { candidateCount: 0, deletedTuids: [], keptTuids: [] };
		}

		const currentPrimaryCorpus = currentPrimaryUnits
			.map((unit) => normalizeText(stripMarkdown(unit.content)))
			.filter((content) => content.length > 0);

		const deletedTuids: string[] = [];
		const keptTuids: string[] = [];
		for (const candidate of candidates) {
			const primaryVariant = candidate.variants.get(this.primaryLang);
			if (!primaryVariant) {
				deletedTuids.push(candidate.tuid);
				continue;
			}

			const normalizedPrimarySeg = normalizeText(primaryVariant.seg);
			const existsInCurrentCorpus = currentPrimaryCorpus.some((content) => containsWholeText(content, normalizedPrimarySeg));
			if (existsInCurrentCorpus) {
				keptTuids.push(candidate.tuid);
				continue;
			}

			deletedTuids.push(candidate.tuid);
		}

		if (deletedTuids.length > 0) {
			this.repository.deleteTuids(deletedTuids);
		}

		return {
			candidateCount: candidates.length,
			deletedTuids,
			keptTuids,
		};
	}
}
