import MarkdownIt from "markdown-it";
import { MdaitHeader } from "./mdait-header";
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
	parse(markdown: string): MdaitSection[];

	/**
	 * セクションをMarkdownテキストに変換
	 * @param sections セクションの配列
	 * @returns Markdownテキスト
	 */
	stringify(sections: MdaitSection[]): string;
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
	parse(markdown: string): MdaitSection[] {
		const sections: MdaitSection[] = [];
		const tokens = this.md.parse(markdown, {});

		let currentSection: {
			mdaitHeader: MdaitHeader;
			title: string;
			level: number;
			bodyTokens: MarkdownIt.Token[];
		} | null = null;
		let inHeading = false;
		// 空のヘッダーで初期化（nullを許容しない）
		let mdaitHeader = new MdaitHeader("");

		// トークンを走査してセクションを抽出
		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i]; // HTMLコメントを処理
			if (token.type === "html_block" && token.content.includes("<!-- mdait")) {
				const parsedHeader = MdaitHeader.parse(token.content);
				if (parsedHeader !== null) {
					mdaitHeader = parsedHeader;
				}
				continue;
			} // 見出しの開始を検出
			if (token.type === "heading_open") {
				inHeading = true;

				// 前のセクションがあれば保存
				if (currentSection) {
					const bodyContent = this.renderTokens(currentSection.bodyTokens);
					// 原文を再構築（見出し + 本文）
					const heading = "#".repeat(currentSection.level);
					const rawContent = `${heading} ${currentSection.title}\n\n${bodyContent}`;

					sections.push(
						new MdaitSection(
							currentSection.mdaitHeader,
							currentSection.title,
							currentSection.level,
							rawContent,
						),
					);
				} // 新しいセクションを開始
				currentSection = {
					mdaitHeader: mdaitHeader,
					title: "",
					level: Number.parseInt(token.tag.substring(1), 10),
					bodyTokens: [],
				};

				// 空のヘッダーで初期化（nullを許容しない）
				mdaitHeader = new MdaitHeader("");
				continue;
			}

			// 見出しの終了を検出
			if (token.type === "heading_close") {
				inHeading = false;
				continue;
			}

			// 見出し内のテキストを取得
			if (inHeading && token.type === "inline") {
				if (currentSection) {
					currentSection.title = token.content;
				}
				continue;
			}

			// 見出し以外のトークンを本文に追加
			if (!inHeading && currentSection) {
				currentSection.bodyTokens.push(token);
			}
		}
		// 最後のセクションを保存
		if (currentSection) {
			const bodyContent = this.renderTokens(currentSection.bodyTokens);
			// 原文を再構築（見出し + 本文）
			const heading = "#".repeat(currentSection.level);
			const rawContent = `${heading} ${currentSection.title}\n\n${bodyContent}`;
			sections.push(
				new MdaitSection(
					currentSection.mdaitHeader,
					currentSection.title,
					currentSection.level,
					rawContent,
				),
			);
		}

		return sections;
	}

	/**
	 * トークン配列をMarkdownテキストに変換
	 */
	private renderTokens(tokens: MarkdownIt.Token[]): string {
		// 型を明示
		return this.md.renderer.render(tokens, this.md.options, {});
	}

	/**
	 * セクションをMarkdownテキストに変換
	 * @param sections セクションの配列
	 * @returns Markdownテキスト
	 */
	stringify(sections: MdaitSection[]): string {
		return sections.map((section) => section.toString()).join("\n\n");
	}
}

/**
 * デフォルトのMarkdownパーサーインスタンス
 * 必要に応じて実装を切り替え可能
 */
export const markdownParser: IMarkdownParser = new MarkdownItParser();
