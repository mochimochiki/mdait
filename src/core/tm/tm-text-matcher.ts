import { normalizeText } from "../hash/normalizer";

const WORD_OR_NUMBER_PATTERN = /[\p{L}\p{N}]/u;

function isTextBoundary(character: string | undefined): boolean {
	return !character || !WORD_OR_NUMBER_PATTERN.test(character);
}

function findPreviousNonWhitespaceCharacter(text: string, startIndex: number): string | undefined {
	for (let index = startIndex; index >= 0; index--) {
		const character = text.charAt(index);
		if (!/\s/u.test(character)) {
			return character;
		}
	}
	return undefined;
}

function findNextNonWhitespaceCharacter(text: string, startIndex: number): string | undefined {
	for (let index = startIndex; index < text.length; index++) {
		const character = text.charAt(index);
		if (!/\s/u.test(character)) {
			return character;
		}
	}
	return undefined;
}

export function findWholeTextPosition(haystack: string, needle: string, fromIndex = 0): number {
	const normalizedHaystack = normalizeText(haystack);
	const normalizedNeedle = normalizeText(needle);
	if (!normalizedHaystack || !normalizedNeedle) {
		return -1;
	}

	let searchIndex = Math.max(0, fromIndex);
	while (searchIndex <= normalizedHaystack.length - normalizedNeedle.length) {
		const matchIndex = normalizedHaystack.indexOf(normalizedNeedle, searchIndex);
		if (matchIndex === -1) {
			return -1;
		}

		const needleStartCharacter = normalizedNeedle.charAt(0);
		const needleEndCharacter = normalizedNeedle.charAt(normalizedNeedle.length - 1);
		const before = findPreviousNonWhitespaceCharacter(normalizedHaystack, matchIndex - 1);
		const afterIndex = matchIndex + normalizedNeedle.length;
		const after = findNextNonWhitespaceCharacter(normalizedHaystack, afterIndex);
		const beforeBoundary = isTextBoundary(needleStartCharacter) || isTextBoundary(before);
		const afterBoundary = isTextBoundary(needleEndCharacter) || isTextBoundary(after);
		if (beforeBoundary && afterBoundary) {
			return matchIndex;
		}

		searchIndex = matchIndex + 1;
	}

	return -1;
}

export function containsWholeText(haystack: string, needle: string): boolean {
	return findWholeTextPosition(haystack, needle) !== -1;
}
