import type { FrontMatter } from "./front-matter";
import type { MdaitUnit } from "./mdait-unit";

export interface Markdown {
	frontMatter?: FrontMatter;
	units: MdaitUnit[];
}
