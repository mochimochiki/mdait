import type { MdaitSection } from "./mdait-section";

export interface FrontMatter {
	// biome-ignore lint/suspicious/noExplicitAny: <explanation>
	[key: string]: any;
}

export interface Markdown {
	frontMatter?: FrontMatter;
	frontMatterRaw?: string;
	sections: MdaitSection[];
}
