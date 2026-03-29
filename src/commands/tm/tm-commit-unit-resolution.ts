/**
 * @file tm-commit-unit-resolution.ts
 * @description
 *   tm-commitにおけるユニット解決の純粋関数。
 *   command-commit.ts から抽出。vscode依存なし。
 * @module commands/tm/tm-commit-unit-resolution
 */
import type { MdaitUnit } from "../../core/markdown/mdait-unit";
import type { TmCommitResolvedUnit } from "./commit-processor";

export interface TmCommitResolutionResult {
	primaryUnit: TmCommitResolvedUnit;
	localUnit: TmCommitResolvedUnit;
}

export interface PreparedTmCommitUnit {
	shouldSkip: boolean;
	resolution: TmCommitResolutionResult | null;
}

export async function prepareTmCommitUnit(
	unit: Pick<MdaitUnit, "marker">,
	resolveUnits: () => Promise<TmCommitResolutionResult | null>,
): Promise<PreparedTmCommitUnit> {
	return {
		shouldSkip: unit.marker === undefined,
		resolution: await resolveUnits(),
	};
}

export async function buildTmCommitUnitResolution(
	currentUnit: TmCommitResolvedUnit,
	sourceUnit: TmCommitResolvedUnit,
	primaryLang: string,
	resolvePrimaryAncestor: (unit: TmCommitResolvedUnit) => Promise<TmCommitResolvedUnit | null>,
): Promise<TmCommitResolutionResult | null> {
	const localUnit = currentUnit.lang === primaryLang ? sourceUnit : currentUnit;
	const candidates = new Map<string, TmCommitResolvedUnit>();

	if (currentUnit.lang === primaryLang) {
		candidates.set(`${currentUnit.unitPath}#${currentUnit.unitHash}`, currentUnit);
	}
	if (sourceUnit.lang === primaryLang) {
		candidates.set(`${sourceUnit.unitPath}#${sourceUnit.unitHash}`, sourceUnit);
	}

	const currentAncestor = currentUnit.lang === primaryLang ? null : await resolvePrimaryAncestor(currentUnit);
	if (currentAncestor) {
		candidates.set(`${currentAncestor.unitPath}#${currentAncestor.unitHash}`, currentAncestor);
	}
	const sourceAncestor = sourceUnit.lang === primaryLang ? null : await resolvePrimaryAncestor(sourceUnit);
	if (sourceAncestor) {
		candidates.set(`${sourceAncestor.unitPath}#${sourceAncestor.unitHash}`, sourceAncestor);
	}

	if (candidates.size !== 1) {
		return null;
	}

	const primaryUnit = candidates.values().next().value as TmCommitResolvedUnit | undefined;
	if (!primaryUnit) {
		return null;
	}

	return { primaryUnit, localUnit };
}
