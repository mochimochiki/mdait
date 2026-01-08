import matter from "gray-matter";
import MarkdownIt from "markdown-it";
import type { Configuration } from "../../config/configuration";
import type { FrontMatter, Markdown } from "./mdait-markdown";
import { MdaitMarker } from "./mdait-marker";
import { MdaitUnit } from "./mdait-unit";

/**
 * ユニット境界を表す内部構造
 */
interface UnitBoundary {
	line: number; // 境界の行番号
	marker?: MdaitMarker; // この境界に付随するマーカー（あれば）
	heading?: {
		// この境界に付随する見出し（あれば）
		level: number;
		title: string;
	};
}

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
	 * 2パスアプローチ: 1. 境界収集 2. ユニット構築
	 * @param markdown Markdownテキスト
	 * @param config 拡張機能の設定
	 * @returns パースされたMarkdownユニットの配列
	 */
	parse(markdown: string, config: Configuration): Markdown {
		const fm = matter(markdown);
		const frontMatter = fm.data as FrontMatter;
		const content = fm.content;
		let frontMatterRaw = "";
		let frontMatterLineOffset = 0;
		
		// フロントマターが存在する場合、frontMatterRawを取得
		// content が空または空白のみの場合（フロントマターのみ）も正しく処理する
		// 注: stringifyが末尾に改行を追加するため、再パース時にcontentが"\n"になる場合がある
		if (content.trim().length === 0 && markdown.trim().length > 0) {
			// フロントマターのみの場合、markdown全体がfrontMatterRaw
			frontMatterRaw = markdown;
			frontMatterLineOffset = frontMatterRaw.split(/\r?\n/).length - 1;
		} else {
			const idx = markdown.indexOf(content);
			if (idx > 0) {
				frontMatterRaw = markdown.substring(0, idx);
				// フロントマターの行数を計算
				frontMatterLineOffset = frontMatterRaw.split(/\r?\n/).length - 1;
			}
		}

		const fontMaterAutoMarkerLevel = frontMatter?.["mdait.sync.autoMarkerLevel"];
		const mdaitMarkerLevel = fontMaterAutoMarkerLevel ?? config?.sync?.autoMarkerLevel ?? 2;

		const parsedMdTokens = this.md.parse(content, {});
		const lines = content.split(/\r?\n/);

		// 第1パス: 境界トークンを収集
		const boundaries = this.collectBoundaries(parsedMdTokens, mdaitMarkerLevel);

		// 第2パス: 境界からユニットを構築
		const units = this.buildUnitsFromBoundaries(boundaries, lines, frontMatterLineOffset);

		return { frontMatter, frontMatterRaw, units: units };
	}

	/**
	 * 第1パス: 境界トークンを収集
	 * mdaitMarkerと指定レベル以上の見出しを境界として抽出する
	 * マーカーの直後に見出しがある場合は、レベルに関係なくマーカーを見出しに統合する
	 * 連続する見出しがある場合は、上位レベル（数値が小さい方）のみを境界として扱う
	 * @param tokens markdown-itのトークン配列
	 * @param mdaitMarkerLevel 検知する見出しレベル（境界として扱うレベル）
	 * @returns ソート済みの境界配列
	 */
	private collectBoundaries(tokens: MarkdownIt.Token[], mdaitMarkerLevel: number): UnitBoundary[] {
		const boundaries: UnitBoundary[] = [];
		const markers: Map<number, MdaitMarker> = new Map(); // 行番号 -> マーカー
		const headings: Map<number, { level: number; title: string }> = new Map(); // 行番号 -> 見出し
		const allHeadings: Map<number, { level: number; title: string }> = new Map(); // 全ての見出し（レベル制限なし）

		let inHeading = false;
		let currentHeadingLevel = 0;
		let currentHeadingTitle = "";
		let currentHeadingLine = 0;

		// マーカーの終了行も記録する
		const markerEndLines = new Map<number, number>(); // 開始行 -> 終了行

		// まず、マーカーと見出しを別々に収集
		for (const token of tokens) {
			// mdaitMarker検出
			if ((token.type === "inline" || token.type === "html_block") && token.content.includes("<!-- mdait")) {
				const marker = MdaitMarker.parse(token.content);
				if (marker !== null && token.map) {
					// マーカーの開始行を記録
					const startLine = token.map[0];
					const endLine = token.map[1];
					markers.set(startLine, marker);
					markerEndLines.set(startLine, endLine);
				}
				continue;
			}

			// 見出し開始検出
			if (token.type === "heading_open") {
				const headingLevel = Number.parseInt(token.tag.substring(1), 10);
				if (token.map) {
					inHeading = true;
					currentHeadingLevel = headingLevel;
					currentHeadingLine = token.map[0];
					currentHeadingTitle = "";
				}
				continue;
			}

			// 見出しタイトル検出
			if (inHeading && token.type === "inline") {
				currentHeadingTitle = token.content;
				continue;
			}

			// 見出し終了検出
			if (token.type === "heading_close" && inHeading) {
				const headingInfo = {
					level: currentHeadingLevel,
					title: currentHeadingTitle,
				};
				// 全ての見出しを記録
				allHeadings.set(currentHeadingLine, headingInfo);
				// 指定レベル以下の見出しのみ境界として記録
				if (currentHeadingLevel <= mdaitMarkerLevel) {
					headings.set(currentHeadingLine, headingInfo);
				}
				inHeading = false;
			}
		}

		// マーカーと見出しを統合して境界を構築
		const processedHeadings = new Set<number>();

		// まず、各マーカーについて直後に見出しがあるか確認
		for (const [markerLine, marker] of markers) {
			// マーカーの終了行を取得（markdown-itのMapは[start, nextStart]形式なので-1不要）
			const markerNextLine = markerEndLines.get(markerLine) ?? markerLine + 1;

			// マーカーの直後に見出しがあるか確認（レベルに関係なく全ての見出しをチェック）
			let foundHeading: { line: number; heading: { level: number; title: string } } | null = null;

			// マーカーの次の行のみチェック（空行を挟まない場合のみ統合）
			const checkLine = markerNextLine;
			const heading = allHeadings.get(checkLine);
			if (heading) {
				foundHeading = { line: checkLine, heading };
				// 境界として扱うべき見出しの場合は記録
				if (headings.has(checkLine)) {
					processedHeadings.add(checkLine);
					
					// マーカーに続く連続した見出しもすべて処理済みとしてマークする
					// これにより、マーカー付き見出しの後に続く見出しが独立した境界として扱われるのを防ぐ
					const headingsArray = Array.from(headings.entries()).sort((a, b) => a[0] - b[0]);
					for (const [nextLine, nextHeading] of headingsArray) {
						if (nextLine <= checkLine) continue;
						
						// 直前の見出しとの間にコンテンツがあるかチェック
						const prevLine = Array.from(processedHeadings).filter(l => l < nextLine).pop() ?? checkLine;
						if (!this.hasContentBetween(prevLine, nextLine, tokens)) {
							processedHeadings.add(nextLine);
						} else {
							break;
						}
					}
				}
			}

			if (foundHeading) {
				// マーカーと見出しを統合
				boundaries.push({
					line: markerLine,
					marker: marker,
					heading: foundHeading.heading,
				});
			} else {
				// マーカーのみ（見出しが後続しない）
				boundaries.push({
					line: markerLine,
					marker: marker,
				});
			}
		}

		// 処理されていない見出しを収集（連続見出しフィルタリング前）
		const headingCandidates: { line: number; heading: { level: number; title: string } }[] = [];
		for (const [line, heading] of headings) {
			if (!processedHeadings.has(line)) {
				headingCandidates.push({ line, heading });
			}
		}
		// 行番号でソート
		headingCandidates.sort((a, b) => a.line - b.line);

		// 連続見出しのフィルタリング
		const filteredHeadings: { line: number; heading: { level: number; title: string } }[] = [];
		for (let i = 0; i < headingCandidates.length; i++) {
			const current = headingCandidates[i];
			
			// 連続する見出しの範囲を特定
			const consecutiveHeadings = [current];
			let j = i + 1;
			while (j < headingCandidates.length) {
				const next = headingCandidates[j];
				// 現在の見出しグループの最後の行と次の見出しの間にコンテンツがあるかチェック
				const lastInGroup = consecutiveHeadings[consecutiveHeadings.length - 1];
				if (!this.hasContentBetween(lastInGroup.line, next.line, tokens)) {
					consecutiveHeadings.push(next);
					j++;
				} else {
					break;
				}
			}

			// 連続する見出しの中で最も上位レベル（数値が小さい）のものを選択
			if (consecutiveHeadings.length > 1) {
				// 最小レベルを持つ見出しを選択（最初に現れるもの）
				const topLevel = Math.min(...consecutiveHeadings.map(h => h.heading.level));
				const topHeading = consecutiveHeadings.find(h => h.heading.level === topLevel);
				if (topHeading) {
					// 最も上位レベルの見出しを選択するが、行番号は最初の見出しのものを使う
					// これにより、連続した見出しの最初の位置が境界となる
					filteredHeadings.push({
						line: consecutiveHeadings[0].line,
						heading: topHeading.heading,
					});
				}
				// 処理した見出しをスキップ
				i = j - 1;
			} else {
				// 独立した見出しはそのまま追加
				filteredHeadings.push(current);
			}
		}

		// フィルタリングされた見出しを境界に追加
		for (const { line, heading } of filteredHeadings) {
			boundaries.push({
				line: line,
				heading: heading,
			});
		}

		// 行番号でソート
		boundaries.sort((a, b) => a.line - b.line);

		return boundaries;
	}

	/**
	 * 指定された行範囲にコンテンツが存在するかチェック
	 * @param startLine 開始行（この行自体は含まない）
	 * @param endLine 終了行（この行自体は含まない）
	 * @param tokens トークン配列
	 * @returns コンテンツが存在する場合true
	 */
	private hasContentBetween(startLine: number, endLine: number, tokens: MarkdownIt.Token[]): boolean {
		for (const token of tokens) {
			if (!token.map) continue;

			const tokenStart = token.map[0];
			const tokenEnd = token.map[1];

			// トークンが範囲内にあるかチェック（startLineより大きく、endLine未満）
			if (tokenStart > startLine && tokenStart < endLine) {
				// 見出しトークンは除外（見出し自体はコンテンツとしてカウントしない）
				if (token.type === "heading_open" || token.type === "heading_close") {
					continue;
				}

				// inline（見出しの中身）も除外
				if (token.type === "inline") {
					// 見出しのinlineは除外
					continue;
				}

				// 実質的なコンテンツがある場合
				if (
					token.type === "paragraph_open" ||
					token.type === "code_block" ||
					token.type === "fence" ||
					token.type === "blockquote_open" ||
					token.type === "list_item_open" ||
					token.type === "hr" ||
					token.type === "table_open"
				) {
					return true;
				}
			}
		}

		return false;
	}

	/**
	 * コンテンツからタイトルを抽出する
	 * @param content コンテンツ文字列
	 * @returns 抽出されたタイトル（最大50文字）
	 */
	private extractTitleFromContent(content: string): string {
		const contentLines = content.split("\n");
		// 空行をスキップして最初の非空行を探す
		for (const line of contentLines) {
			const trimmedLine = line.trim();
			if (trimmedLine && !trimmedLine.startsWith("<!--") && !trimmedLine.startsWith("#")) {
				// 最大50文字までをタイトルとして使用
				return trimmedLine.length > 50 ? `${trimmedLine.substring(0, 50)}...` : trimmedLine;
			}
		}
		return "";
	}

	/**
	 * 本文から始まるユニットの先頭にある空行を除去
	 * @param content コンテンツ文字列
	 * @returns 先頭空行を除去したコンテンツ
	 */
	private trimLeadingEmptyLines(content: string): string {
		const contentLines = content.split("\n");
		while (contentLines.length > 0 && contentLines[0].trim() === "") {
			contentLines.shift();
		}
		return contentLines.join("\n");
	}

	/**
	 * 第2パス: 境界からユニットを構築
	 * 境界間のコンテンツを抽出し、MdaitUnitを生成する
	 * @param boundaries 境界配列
	 * @param lines コンテンツの行配列
	 * @param frontMatterLineOffset フロントマターの行オフセット
	 * @returns MdaitUnitの配列
	 */
	private buildUnitsFromBoundaries(
		boundaries: UnitBoundary[],
		lines: string[],
		frontMatterLineOffset: number,
	): MdaitUnit[] {
		if (boundaries.length === 0) {
			return [];
		}

		const units: MdaitUnit[] = [];

		// 最初の境界より前にコンテンツがある場合、それを独立したユニットとして扱う
		const firstBoundaryLine = boundaries[0].line;
		if (firstBoundaryLine > 0) {
			const precedingContent = lines.slice(0, firstBoundaryLine).join("\n");
			const normalizedPrecedingContent = this.trimLeadingEmptyLines(precedingContent);
			// 空白のみでない場合はユニットとして追加
			if (precedingContent.trim().length > 0) {
				const title = this.extractTitleFromContent(normalizedPrecedingContent);
				units.push(
					new MdaitUnit(
						// 空のマーカーを作成（sync時にensureMdaitMarkerHashでハッシュが付与される）
						new MdaitMarker(""),
						title,
						0, // レベルなし
						normalizedPrecedingContent,
						frontMatterLineOffset,
						firstBoundaryLine - 1 + frontMatterLineOffset,
					),
				);
			}
		}

		for (let i = 0; i < boundaries.length; i++) {
			const boundary = boundaries[i];
			const startLine = boundary.line;

			// 次の境界までをこのユニットのコンテンツとする
			const endLine = i + 1 < boundaries.length ? boundaries[i + 1].line : lines.length;
			let rawContent = lines.slice(startLine, endLine).join("\n");

			// マーカーと見出し情報を取得（既にcollectBoundariesで統合済み）
			const marker = boundary.marker ?? new MdaitMarker("");
			let title = boundary.heading?.title ?? "";
			const level = boundary.heading?.level ?? 0;

			// contentからmdaitマーカーを除去（toString時に再度追加されるため）
			// マーカーが存在する場合（ハッシュの有無に関わらず）
			if (boundary.marker) {
				// マーカーの行を除去（最初の行がマーカーの場合）
				const contentLines = rawContent.split("\n");
				if (contentLines[0].includes("<!-- mdait")) {
					contentLines.shift();
					// マーカーの後の空行も除去（もしあれば）
					if (contentLines.length > 0 && contentLines[0].trim() === "") {
						contentLines.shift();
					}
					rawContent = contentLines.join("\n");
				}
			}

			// 本文から始まるユニットでは先頭空行を除去して、マーカー直下に空行を残さない
			if (level === 0) {
				rawContent = this.trimLeadingEmptyLines(rawContent);
			}

			// タイトルが空の場合、コンテンツからタイトルを抽出
			if (!title && rawContent) {
				title = this.extractTitleFromContent(rawContent);
			}

			units.push(
				new MdaitUnit(
					marker,
					title,
					level,
					rawContent,
					startLine + frontMatterLineOffset,
					endLine - 1 + frontMatterLineOffset,
				),
			);
		}

		return units;
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
		const body = doc.units.map((section) => section.toString().replace(/\n+$/g, "")).join("\n\n");
		return `${fm}${body}\n`;
	}
}

/**
 * デフォルトのMarkdownパーサーインスタンス
 * 必要に応じて実装を切り替え可能
 */
export const markdownParser: IMarkdownParser = new MarkdownItParser();
