import type { MdaitUnit } from "../../core/markdown/mdait-unit";
import type { CurrentPrimaryUnit } from "../../core/tm/types";
import type { TransPair } from "../../infra/config/configuration";

export function collectCurrentPrimaryUnits(units: readonly MdaitUnit[], unitPath: string): CurrentPrimaryUnit[] {
	return units
		.filter((unit) => Boolean(unit.marker?.hash))
		.map((unit) => ({
			unitPath,
			unitHash: unit.marker?.hash ?? "",
			content: unit.content,
		}));
}

export function collectPrimarySourceFilePathsForCleanup(
	sourceFilePaths: readonly string[],
	pair: TransPair,
	primaryLang: string,
	alreadyCollectedFilePaths: ReadonlySet<string>,
): string[] {
	if (pair.sourceLang !== primaryLang) {
		return [];
	}

	return sourceFilePaths.filter((sourceFilePath) => !alreadyCollectedFilePaths.has(sourceFilePath));
}
