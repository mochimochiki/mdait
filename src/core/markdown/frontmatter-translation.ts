import type { Configuration } from "../../config/configuration";
import { calculateHash } from "../hash/hash-calculator";
import type { FrontMatter } from "./front-matter";
import { MdaitMarker } from "./mdait-marker";

export const FRONTMATTER_MARKER_KEY = "mdait.front";

export function getFrontmatterTranslationKeys(config: Configuration): string[] {
	const keys = config.trans.frontmatter?.keys ?? [];
	return keys.filter((key) => key && key !== FRONTMATTER_MARKER_KEY);
}

export function getFrontmatterTranslationValues(
	frontMatter: FrontMatter | undefined,
	keys: string[],
): Record<string, string> {
	const values: Record<string, string> = {};
	if (!frontMatter) {
		return values;
	}

	for (const key of keys) {
		const value = frontMatter.get(key);
		if (typeof value === "string") {
			values[key] = value;
		}
	}

	return values;
}

export function calculateFrontmatterHash(
	frontMatter: FrontMatter | undefined,
	keys: string[],
	options: { allowEmpty?: boolean } = {},
): string | null {
	if (!frontMatter || keys.length === 0) {
		return null;
	}

	const values = keys.map((key) => {
		const value = frontMatter.get(key);
		return typeof value === "string" ? value : "";
	});

	if (!options.allowEmpty && values.every((value) => value === "")) {
		return null;
	}

	return calculateHash(values.join("\n"));
}

export function parseFrontmatterMarker(frontMatter: FrontMatter | undefined): MdaitMarker | null {
	if (!frontMatter) {
		return null;
	}

	const raw = frontMatter.get(FRONTMATTER_MARKER_KEY);
	if (typeof raw !== "string" || raw.trim().length === 0) {
		return null;
	}

	return MdaitMarker.parse(`<!-- mdait ${raw} -->`);
}

export function serializeFrontmatterMarker(marker: MdaitMarker): string {
	return marker
		.toString()
		.replace(/^<!-- mdait\s*/u, "")
		.replace(/\s*-->$/u, "")
		.trim();
}

export function setFrontmatterMarker(frontMatter: FrontMatter, marker: MdaitMarker | null): void {
	if (!marker || !marker.hash) {
		if (frontMatter.has(FRONTMATTER_MARKER_KEY)) {
			frontMatter.delete(FRONTMATTER_MARKER_KEY);
		}
		return;
	}

	frontMatter.set(FRONTMATTER_MARKER_KEY, serializeFrontmatterMarker(marker));
}
