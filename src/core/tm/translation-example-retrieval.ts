import { normalizeText } from "../hash/normalizer";
import type { TmxStore } from "./tmx-store";
import type { TranslationExampleCandidate, TranslationExampleMatch } from "./types";

function createBigrams(text: string): string[] {
	if (text.length < 2) {
		return text ? [text] : [];
	}
	const normalized = text.toLowerCase();
	const bigrams: string[] = [];
	for (let i = 0; i < normalized.length - 1; i++) {
		bigrams.push(normalized.slice(i, i + 2));
	}
	return bigrams;
}

function calculateStringSimilarity(a: string, b: string): number {
	if (!a || !b) {
		return 0;
	}
	if (a === b) {
		return 1;
	}
	const aBigrams = createBigrams(a);
	const bBigrams = createBigrams(b);
	const bCounts = new Map<string, number>();
	for (const bigram of bBigrams) {
		bCounts.set(bigram, (bCounts.get(bigram) ?? 0) + 1);
	}
	let intersection = 0;
	for (const bigram of aBigrams) {
		const count = bCounts.get(bigram) ?? 0;
		if (count > 0) {
			intersection++;
			bCounts.set(bigram, count - 1);
		}
	}
	return (2 * intersection) / (aBigrams.length + bBigrams.length);
}

function calculateLengthCloseness(a: string, b: string): number {
	if (!a || !b) {
		return 0;
	}
	const maxLength = Math.max(a.length, b.length);
	if (maxLength === 0) {
		return 1;
	}
	return 1 - Math.abs(a.length - b.length) / maxLength;
}

function buildScore(
	candidate: TranslationExampleCandidate,
	normalizedSeeds: readonly string[],
): { score: number; exactMatch: boolean } {
	const normalizedSource = normalizeText(candidate.source.seg);
	const exactMatch = normalizedSeeds.includes(normalizedSource);
	if (exactMatch) {
		return { score: 10_000, exactMatch: true };
	}

	let similarity = 0;
	let lengthCloseness = 0;
	for (const seed of normalizedSeeds) {
		similarity = Math.max(similarity, calculateStringSimilarity(seed, normalizedSource));
		lengthCloseness = Math.max(lengthCloseness, calculateLengthCloseness(seed, normalizedSource));
	}

	return {
		score: similarity * 100 + lengthCloseness * 10,
		exactMatch: false,
	};
}

export class TranslationExampleRetrievalService {
	constructor(
		private readonly repository: TmxStore,
		private readonly maxReferences: number,
	) {}

	retrieveExamples(seeds: readonly string[], sourceLang: string, targetLang: string): TranslationExampleMatch[] {
		const normalizedSeeds = seeds.map((seed) => normalizeText(seed)).filter((seed) => seed.length > 0);
		if (normalizedSeeds.length === 0) {
			return [];
		}

		const candidates = this.repository.generateRetrievalCandidates(normalizedSeeds, sourceLang, targetLang);
		const ranked = candidates
			.map((candidate) => {
				const { score, exactMatch } = buildScore(candidate, normalizedSeeds);
				return {
					tuid: candidate.tuid,
					source: candidate.source.seg,
					target: candidate.target.seg,
					firstUsedIn: candidate.source.unitPath,
					score,
					exactMatch,
				};
			})
			.sort((a, b) => b.score - a.score || a.tuid.localeCompare(b.tuid));

		return ranked.slice(0, this.maxReferences);
	}
}
