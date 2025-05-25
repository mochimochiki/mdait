import type { MdaitUnit } from "./mdait-unit";

export interface FrontMatter {
	// biome-ignore lint/suspicious/noExplicitAny: <explanation>
	[key: string]: any;
}

export interface Markdown {
	frontMatter?: FrontMatter;
	frontMatterRaw?: string;
	units: MdaitUnit[];
}
