import MarkdownIt from "markdown-it";
import type { Configuration } from "../../infra/config/configuration";
import { getCodeBlockLineSet } from "./code-block-lines";
import { FrontMatter } from "./front-matter";
import { type MarkerFileContext, type MarkerProvider, embeddedMarkerProvider } from "./marker-provider";
import type { Markdown } from "./mdait-markdown";
import { MdaitMarker } from "./mdait-marker";
import { MdaitUnit } from "./mdait-unit";

/**
 * HTMLコメント範囲を表す内部構造
 */
interface HtmlCommentRange {
	startLine: number; // 開始行（0-indexed）
	endLine: number; // 終了行（0-indexed、exclusive）
}

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
	 * @param provider マーカーの出し入れ口（省略時は埋め込み=現状維持）
	 * @param ctx マーカー保管先を解決するためのファイルコンテキスト（external で使用）
	 * @returns パースされたMarkdownユニットの配列
	 */
	parse(markdown: string, config?: Configuration, provider?: MarkerProvider, ctx?: MarkerFileContext): Markdown;

	/**
	 * ユニットをMarkdownテキストに変換
	 * @param doc Markdownドキュメント
	 * @param provider マーカーの出し入れ口（省略時は埋め込み=現状維持）
	 * @param ctx マーカー保管先を解決するためのファイルコンテキスト（external で使用）
	 * @returns Markdownテキスト
	 */
	stringify(doc: Markdown, provider?: MarkerProvider, ctx?: MarkerFileContext): string;
}

/**
 * MarkdownItを使用したパーサー実装
 */
export class MarkdownItParser implements IMarkdownParser {
	private md: MarkdownIt;

	/**
	 * mdaitマーカーの正規表現パターン
	 * 行頭のマーカーを検出するためのパターン
	 */
	private static readonly MDAIT_MARKER_LINE_REGEX =
		/^<!-- mdait(?:\s+[a-zA-Z0-9]+)?(?:\s+from:[a-zA-Z0-9]+)?(?:\s+need:[\w@]+)?\s*-->\s*$/;

	/**
	 * コンストラクタ
	 */
	constructor() {
		this.md = new MarkdownIt({
			breaks: true,
		});
	}

	/**
	 * mdaitマーカーの直前に空行がなければ空行を挿入する正規化処理
	 * markdown-itが正しくトークン化するための前処理
	 *
	 * 問題: markdown-itは空行で段落を区切る。マーカーの直前に空行がないと、
	 * マーカーが前のテキストと同じinlineトークンに含まれてしまい、
	 * 境界として正しく検出されない。
	 *
	 * コードブロック内の行は対象外（design.md P9）。利用者が書いたサンプルのマーカーは
	 * 境界にならないため空行を入れる理由が無く、入れれば本文（コードブロックの中身）を
	 * 書き換えてしまう。
	 *
	 * @param content フロントマターを除いた本文コンテンツ
	 * @returns 正規化されたコンテンツ
	 */
	private normalizeMarkerSpacing(content: string): string {
		const lines = content.split(/\r?\n/);
		const codeBlockLines = getCodeBlockLineSet(content);
		const result: string[] = [];

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const trimmedLine = line.trim();

			// mdaitマーカー行かどうかをチェック（コードブロック内は本文なので触らない）
			if (!codeBlockLines.has(i) && MarkdownItParser.MDAIT_MARKER_LINE_REGEX.test(trimmedLine)) {
				// 直前の行が空行でない場合（かつ先頭行でない場合）、空行を挿入
				if (i > 0 && result.length > 0 && result[result.length - 1].trim() !== "") {
					result.push("");
				}
			}

			result.push(line);
		}

		return result.join("\n");
	}

	/**
	 * Markdownテキストをユニットに分割してパースする
	 * 2パスアプローチ: 1. 境界収集 2. ユニット構築
	 * @param markdown Markdownテキスト
	 * @param config 拡張機能の設定
	 * @returns パースされたMarkdownユニットの配列
	 */
	parse(
		markdown: string,
		config: Configuration,
		provider: MarkerProvider = embeddedMarkerProvider,
		ctx?: MarkerFileContext,
	): Markdown {
		const { frontMatter, content, frontMatterLineOffset } = FrontMatter.parse(markdown);

		const fontMaterlevel = frontMatter?.get("mdait.sync.level");
		const mdaitMarkerLevel = fontMaterlevel ?? config?.sync?.level ?? 2;

		// 前処理: mdaitマーカーの直前に空行がなければ挿入（markdown-it正規化）
		const normalizedContent = this.normalizeMarkerSpacing(content);
		const parsedMdTokens = this.md.parse(normalizedContent, {});
		// 境界構築には正規化後のコンテンツを使用
		const lines = normalizedContent.split(/\r?\n/);

		// HTMLコメント範囲を検出
		const htmlCommentRanges = this.collectHtmlCommentRanges(parsedMdTokens);

		// 第1パス: 境界トークンを収集
		const boundaries = this.collectBoundaries(
			parsedMdTokens,
			mdaitMarkerLevel,
			htmlCommentRanges,
			provider.markersFormBoundaries,
		);

		// 第2パス: 境界からユニットを構築
		const units = this.buildUnitsFromBoundaries(boundaries, lines, frontMatterLineOffset);

		// 外部由来マーカーをユニットに後付けする（embedded は no-op）
		provider.attachMarkers(units, ctx);

		return { frontMatter, units: units };
	}

	/**
	 * HTMLコメント範囲を検出
	 * html_blockトークン、またはinline/paragraph内のHTMLコメントを抽出する
	 * <!-- mdait で始まるものは除外（mdait管理用マーカー）
	 * @param tokens markdown-itのトークン配列
	 * @returns HTMLコメント範囲の配列
	 */
	private collectHtmlCommentRanges(tokens: MarkdownIt.Token[]): HtmlCommentRange[] {
		const ranges: HtmlCommentRange[] = [];

		for (const token of tokens) {
			// html_blockトークンをチェック
			if (token.type === "html_block" && token.map) {
				const content = token.content.trim();

				// <!-- で始まり --> で終わることを確認
				if (content.startsWith("<!--") && content.endsWith("-->")) {
					// mdait管理用マーカーは除外
					if (!content.startsWith("<!-- mdait")) {
						ranges.push({
							startLine: token.map[0],
							endLine: token.map[1],
						});
					}
				}
			}

			// inlineトークン内のHTMLコメントをチェック
			if (token.type === "inline" && token.map && token.content) {
				const content = token.content.trim();

				// <!-- で始まり --> で終わることを確認
				if (content.startsWith("<!--") && content.endsWith("-->")) {
					// mdait管理用マーカーは除外
					if (!content.startsWith("<!-- mdait")) {
						ranges.push({
							startLine: token.map[0],
							endLine: token.map[1],
						});
					}
				}
			}
		}

		return ranges;
	}

	/**
	 * 指定された行がHTMLコメント範囲内かどうかを判定
	 * @param line 行番号（0-indexed）
	 * @param ranges HTMLコメント範囲の配列
	 * @returns HTMLコメント範囲内ならtrue
	 */
	private isInHtmlComment(line: number, ranges: HtmlCommentRange[]): boolean {
		return ranges.some((r) => line >= r.startLine && line < r.endLine);
	}

	/**
	 * 第1パス: 境界トークンを収集
	 * mdaitMarkerと指定レベル以上の見出しを境界として抽出する
	 * マーカーの直後に見出しがある場合は、レベルに関係なくマーカーを見出しに統合する
	 * @param tokens markdown-itのトークン配列
	 * @param mdaitMarkerLevel 検知する見出しレベル（境界として扱うレベル）
	 * @param htmlCommentRanges HTMLコメント範囲の配列
	 * @param markersFormBoundaries マーカー単独で境界を形成するか（embedded=true）。
	 *   external（false）ではマーカー単独境界を作らない分岐がフェーズ1で必要になる。
	 * @returns ソート済みの境界配列
	 */
	private collectBoundaries(
		tokens: MarkdownIt.Token[],
		mdaitMarkerLevel: number,
		htmlCommentRanges: HtmlCommentRange[],
		markersFormBoundaries = true,
	): UnitBoundary[] {
		// external（markersFormBoundaries === false）では、マーカー単独境界（見出しを伴わない
		// 手動サブ境界）を作らない。境界は「見出しレベル≤閾値」＋「先頭本文ユニット」のみとし、
		// マーカーは ExternalMarkerProvider.attachMarkers が order/titleHash で後付けする。
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
			// mdaitMarker検出（external ではマーカーを境界収集しない＝防御的に無視して継続）
			if ((token.type === "inline" || token.type === "html_block") && token.content.includes("<!-- mdait")) {
				if (!markersFormBoundaries) {
					continue;
				}
				const marker = MdaitMarker.parse(token.content);
				if (marker !== null && token.map) {
					// HTMLコメント範囲内の場合はスキップ
					const startLine = token.map[0];
					if (this.isInHtmlComment(startLine, htmlCommentRanges)) {
						continue;
					}

					// マーカーの開始行を記録
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

		// 処理されていない見出しを追加
		for (const [line, heading] of headings) {
			if (!processedHeadings.has(line)) {
				boundaries.push({
					line: line,
					heading: heading,
				});
			}
		}

		// 行番号でソート
		boundaries.sort((a, b) => a.line - b.line);

		return boundaries;
	}

	/**
	 * 指定されたコンテンツがHTMLコメントのみで構成されているかをチェック
	 * @param content チェック対象のコンテンツ
	 * @returns HTMLコメントのみの場合true
	 */
	private isOnlyHtmlComments(content: string): boolean {
		// 空白と改行を除去
		const trimmed = content.trim();
		if (trimmed === "") {
			return false;
		}

		// HTMLコメントパターン: <!-- ... --> (単一行または複数行)
		// すべてのHTMLコメントを除去して、残りがあるかチェック
		let remaining = trimmed;

		// HTMLコメントを繰り返し除去
		const commentPattern = /<!--[\s\S]*?-->/g;
		remaining = remaining.replace(commentPattern, "");

		// 残りが空白のみならtrue（HTMLコメントのみで構成されている）
		return remaining.trim() === "";
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
			const allContent = lines.join("\n");
			const normalizedContent = this.trimLeadingEmptyLines(allContent);
			if (normalizedContent.trim().length > 0) {
				const title = this.extractTitleFromContent(normalizedContent);
				return [
					new MdaitUnit(
						new MdaitMarker(""),
						title,
						0,
						normalizedContent,
						frontMatterLineOffset,
						lines.length - 1 + frontMatterLineOffset,
					),
				];
			}
			return [];
		}

		const units: MdaitUnit[] = [];

		// 最初の境界より前にコンテンツがある場合の処理
		let precedingHtmlComments = "";
		const firstBoundaryLine = boundaries[0].line;
		if (firstBoundaryLine > 0) {
			const precedingContent = lines.slice(0, firstBoundaryLine).join("\n");
			const normalizedPrecedingContent = this.trimLeadingEmptyLines(precedingContent);

			// HTMLコメントのみの場合は、最初のユニットに含めるために保存
			if (this.isOnlyHtmlComments(normalizedPrecedingContent)) {
				precedingHtmlComments = `${precedingContent}\n\n`;
			} else if (precedingContent.trim().length > 0) {
				// HTMLコメントでない通常のコンテンツの場合は独立したユニットとして追加
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

			// 最初のユニットの場合、先頭のHTMLコメントを含める
			if (i === 0 && precedingHtmlComments) {
				rawContent = precedingHtmlComments + rawContent;
			}

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
	stringify(doc: Markdown, provider: MarkerProvider = embeddedMarkerProvider, ctx?: MarkerFileContext): string {
		// ユニットからマーカーを引き取り永続化する（embedded は no-op）
		provider.detachMarkers(doc.units, ctx);

		if (doc.units.length === 0) {
			// ユニットがない場合はfrontmatterのみ。
			// raw は frontmatter-only 時にパース元の末尾改行を含むことがあり（front-matter.ts parse 参照）、
			// マーカー不変でsourceのrawが再生成されないと sync ごとに改行が積み上がるため、末尾を正規化する。
			// CRLF の \r も含めて末尾の改行類をまとめて除去し、改行種別に依存せず冪等にする。
			if (doc.frontMatter && !doc.frontMatter.isEmpty()) {
				return `${doc.frontMatter.raw.replace(/[\r\n]+$/, "")}\n`;
			}
			return "";
		}

		// frontmatterがある場合
		let result = "";
		if (doc.frontMatter && !doc.frontMatter.isEmpty()) {
			// 本文ありファイルでは、sync 中に _data のマーカーが更新されても _raw が古いまま残ることがあり、
			// それが「frontマーカーが1回のsyncで確定しない」非冪等の原因になる。_data を正として整合させる。
			doc.frontMatter.reconcileRaw();
			result = doc.frontMatter.raw;
			// frontmatter後の改行
			if (!result.endsWith("\n")) {
				result += "\n";
			}
		}

		// ユニット間は2つの改行で連結し、余分な改行増加を防ぐ。
		// external ではマーカーを本文に埋め込まない（detach で外部ストアに退避済み）ため、
		// マーカー行を含まない純本文（unit.content）を出力する。
		const emitMarkers = provider.mode !== "external";
		const unitStrings = doc.units.map((section) =>
			(emitMarkers ? section.toString() : section.content).replace(/\n+$/g, ""),
		);

		if (result) {
			// frontmatterがある場合、最初のユニットは直後に配置（空白行なし）
			result += unitStrings[0];
			// 2番目以降のユニットは\n\nで連結
			for (let i = 1; i < unitStrings.length; i++) {
				result += `\n\n${unitStrings[i]}`;
			}
		} else {
			// frontmatterがない場合、全ユニットを\n\nで連結
			result = unitStrings.join("\n\n");
		}

		return `${result}\n`;
	}
}

/**
 * デフォルトのMarkdownパーサーインスタンス
 * 必要に応じて実装を切り替え可能
 */
export const markdownParser: IMarkdownParser = new MarkdownItParser();
