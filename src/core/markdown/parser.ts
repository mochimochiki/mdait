import matter from "gray-matter";
import MarkdownIt from "markdown-it";
import { MdaitHeader } from "./mdait-header";
import type { FrontMatter, Markdown } from "./mdait-markdown";
import { MdaitSection } from "./mdait-section";

/**
 * Markdownパーサーインターフェース
 */
export interface IMarkdownParser {
	/**
	 * Markdownテキストをセクションに分割してパースする
	 * @param markdown Markdownテキスト
	 * @returns パースされたMarkdownセクションの配列
	 */
	parse(markdown: string): Markdown;

	/**
	 * セクションをMarkdownテキストに変換
	 * @param sections セクションの配列
	 * @returns Markdownテキスト
	 */
	stringify(doc: Markdown): string;
}

/**
 * MarkdownItを使用したパーサー実装
 */
export class MarkdownItParser implements IMarkdownParser {
	private md: MarkdownIt;

	/**
	 * コンストラクタ
	 */
	constructor() {
		this.md = new MarkdownIt();
	}

	/**
	 * Markdownテキストをセクションに分割してパースする
	 * markdown-itを使用して解析し、トークンからセクションを構築
	 * @param markdown Markdownテキスト
	 * @returns パースされたMarkdownセクションの配列
	 */
	parse(markdown: string): Markdown {
		const fm = matter(markdown);
		const frontMatter = fm.data as FrontMatter;
		const content = fm.content;
		let frontMatterRaw = "";
		const idx = markdown.indexOf(content);
		if (idx > 0) {
			frontMatterRaw = markdown.substring(0, idx);
		}
		const sections: MdaitSection[] = [];
		const tokens = this.md.parse(content, {});
		const lines = content.split(/\r?\n/);

		let currentSection: {
			mdaitHeader: MdaitHeader;
			title: string;
			level: number;
			startLine: number | null;
			endLine: number | null;
		} | null = null;
		let inHeading = false;
		let mdaitHeader = new MdaitHeader("");

		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i];
			if (
				(token.type === "inline" || token.type === "html_block") &&
				token.content.includes("<!-- mdait")
			) {
				const parsedHeader = MdaitHeader.parse(token.content);
				if (parsedHeader !== null) {
					mdaitHeader = parsedHeader;
				}
				continue;
			}
			if (token.type === "heading_open") {
				inHeading = true;

				// 前のセクションがあれば保存
				if (currentSection && currentSection.startLine !== null) {
					const start = currentSection.startLine;
					const end =
						currentSection.endLine !== null
							? currentSection.endLine
							: lines.length;
					const rawContent = lines.slice(start, end).join("\n");
					sections.push(
						new MdaitSection(
							currentSection.mdaitHeader,
							currentSection.title,
							currentSection.level,
							rawContent,
						),
					);
				}
				// 新しいセクションを開始
				currentSection = {
					mdaitHeader: mdaitHeader,
					title: "",
					level: Number.parseInt(token.tag.substring(1), 10),
					startLine: token.map ? token.map[0] : null,
					endLine: null,
				};
				mdaitHeader = new MdaitHeader("");
				continue;
			}
			if (token.type === "heading_close") {
				inHeading = false;
				continue;
			}
			if (inHeading && token.type === "inline") {
				if (currentSection) {
					currentSection.title = token.content;
				}
			}
		}
		// 最後のセクションを保存
		if (currentSection && currentSection.startLine !== null) {
			const start = currentSection.startLine;
			const end =
				currentSection.endLine !== null ? currentSection.endLine : lines.length;
			const rawContent = lines.slice(start, end).join("\n");
			sections.push(
				new MdaitSection(
					currentSection.mdaitHeader,
					currentSection.title,
					currentSection.level,
					rawContent,
				),
			);
		}
		return { frontMatter, frontMatterRaw, sections };
	}

	/**
	 * セクションをMarkdownテキストに変換
	 * @param sections セクションの配列
	 * @returns Markdownテキスト
	 */
	stringify(doc: Markdown): string {
		let fm = "";
		if (doc.frontMatterRaw && doc.frontMatterRaw.trim().length > 0) {
			fm = `${doc.frontMatterRaw}`;
		}
		return fm + doc.sections.map((section) => section.toString()).join("\n\n");
	}
}

/**
 * デフォルトのMarkdownパーサーインスタンス
 * 必要に応じて実装を切り替え可能
 */
export const markdownParser: IMarkdownParser = new MarkdownItParser();
