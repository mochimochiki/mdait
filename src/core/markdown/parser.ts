import matter from "gray-matter";
import MarkdownIt from "markdown-it";
import { Configuration } from "../../config/configuration";
import type { FrontMatter, Markdown } from "./mdait-markdown";
import { MdaitMarker } from "./mdait-marker";
import { MdaitUnit } from "./mdait-unit";

/**
 * Markdownパーサーインターフェース
 */
export interface IMarkdownParser {
	/**
	 * Markdownテキストをユニットに分割してパースする
	 * @param markdown Markdownテキスト
	 * @param config 拡張機能の設定
	 * @returns パースされたMarkdownユニットの配列
	 */
	parse(markdown: string, config?: Configuration): Markdown;

	/**
	 * ユニットをMarkdownテキストに変換
	 * @param doc Markdownドキュメント
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
	 * Markdownテキストをユニットに分割してパースする
	 * markdown-itを使用して解析し、トークンからユニットを構築
	 * @param markdown Markdownテキスト
	 * @param config 拡張機能の設定
	 * @returns パースされたMarkdownユニットの配列
	 */
	parse(markdown: string, config?: Configuration): Markdown {
		const defaultConfig = new Configuration();
		// config
		const autoMarkerLevel = config?.sync.autoMarkerLevel ?? defaultConfig.sync.autoMarkerLevel;

		const fm = matter(markdown);
		const frontMatter = fm.data as FrontMatter;
		const content = fm.content;
		let frontMatterRaw = "";
		let frontMatterLineOffset = 0;
		const idx = markdown.indexOf(content);
		if (idx > 0) {
			frontMatterRaw = markdown.substring(0, idx);
			// フロントマターの行数を計算
			frontMatterLineOffset = frontMatterRaw.split(/\r?\n/).length - 1;
		}
		const units: MdaitUnit[] = [];
		const tokens = this.md.parse(content, {});
		const lines = content.split(/\r?\n/);

		let currentSection: {
			marker: MdaitMarker;
			title: string;
			level: number;
			startLine: number | null;
			endLine: number | null;
		} | null = null;
		let inHeading = false;
		let mdaitMarker = new MdaitMarker("");

		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i];
			if (
				(token.type === "inline" || token.type === "html_block") &&
				token.content.includes("<!-- mdait")
			) {
				// mdaitコメントが現れた時点で、現在のユニットをここで区切る
				if (currentSection && currentSection.startLine !== null) {
					const start = currentSection.startLine;
					const end = token.map ? token.map[0] : lines.length;
					const rawContent = lines.slice(start, end).join("\n");
					units.push(
						new MdaitUnit(
							currentSection.marker,
							currentSection.title,
							currentSection.level,
							rawContent,
							start + frontMatterLineOffset,
							end - 1 + frontMatterLineOffset,
						),
					);
					currentSection = null;
				}
				const parsedHeader = MdaitMarker.parse(token.content);
				if (parsedHeader !== null) {
					mdaitMarker = parsedHeader;
				}
				continue;
			}
			if (token.type === "heading_open") {
				const headingLevel = Number.parseInt(token.tag.substring(1), 10);
				// 設定された見出しレベルより深い場合は、新しいユニットを開始しない
				if (headingLevel > autoMarkerLevel && currentSection) {
					continue;
				}

				// 前のユニットがあれば保存
				if (currentSection && currentSection.startLine !== null) {
					const start = currentSection.startLine;
					// 次の見出しが出てくるまでを1ユニットとする
					const end = token.map ? token.map[0] : lines.length;
					const rawContent = lines.slice(start, end).join("\n");
					units.push(
						new MdaitUnit(
							currentSection.marker,
							currentSection.title,
							currentSection.level,
							rawContent,
							start + frontMatterLineOffset,
							end - 1 + frontMatterLineOffset,
						),
					);
				}
				// 新しいユニットを開始
				currentSection = {
					marker: mdaitMarker,
					title: "",
					level: headingLevel,
					startLine: token.map ? token.map[0] : null,
					endLine: null,
				};
				mdaitMarker = new MdaitMarker("");
				inHeading = true;
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
		// 最後のユニットを保存
		if (currentSection && currentSection.startLine !== null) {
			const start = currentSection.startLine;
			const end = lines.length;
			const rawContent = lines.slice(start, end).join("\n");
			units.push(
				new MdaitUnit(
					currentSection.marker,
					currentSection.title,
					currentSection.level,
					rawContent,
					start + frontMatterLineOffset,
					end - 1 + frontMatterLineOffset,
				),
			);
		}
		return { frontMatter, frontMatterRaw, units: units };
	}

	/**
	 * ユニットをMarkdownテキストに変換
	 * @param doc Markdownドキュメント
	 * @returns Markdownテキスト
	 */
	stringify(doc: Markdown): string {
		let fm = "";
		if (doc.frontMatterRaw && doc.frontMatterRaw.trim().length > 0) {
			fm = `${doc.frontMatterRaw}`;
		}
		// ユニット間は1つの改行で連結し、余分な改行増加を防ぐ
		const body = doc.units
			.map((section) => section.toString().replace(/\n+$/g, ""))
			.join("\n\n");
		return `${fm}${body}\n`;
	}
}

/**
 * デフォルトのMarkdownパーサーインスタンス
 * 必要に応じて実装を切り替え可能
 */
export const markdownParser: IMarkdownParser = new MarkdownItParser();
