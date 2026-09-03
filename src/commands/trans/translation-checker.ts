/**
 * @file translation-checker.ts
 * @description
 *   翻訳結果の品質をチェックし、確認推奨箇所を検出するモジュール。
 *   markdown-itでパースした構造を比較し、Markdown要素の不一致を検出。
 * @module commands/trans/translation-checker
 */

import MarkdownIt from "markdown-it";

/**
 * 確認推奨理由
 */
export interface ReviewReason {
	/** 理由のカテゴリ */
	category:
		| "heading_mismatch"
		| "list_mismatch"
		| "code_block_mismatch"
		| "blockquote_mismatch"
		| "table_mismatch"
		| "link_mismatch"
		| "image_mismatch"
		| "structure_mismatch";
	/** 詳細メッセージ */
	message: string;
}

/**
 * 翻訳チェック結果
 */
export interface TranslationCheckResult {
	/** 確認推奨かどうか */
	needsReview: boolean;
	/** 確認推奨理由のリスト */
	reasons: ReviewReason[];
}

/**
 * Markdown構造のサマリー
 */
interface MarkdownStructure {
	/** 見出しレベル別カウント（例: {1: 2, 2: 5}） */
	headings: Map<number, number>;
	/** リスト項目数（箇条書き・番号付き） */
	listItems: number;
	/** コードブロック数 */
	codeBlocks: number;
	/** 引用ブロック数 */
	blockquotes: number;
	/** テーブル数 */
	tables: number;
	/** リンク数 */
	links: number;
	/** 画像数 */
	images: number;
}

/**
 * 翻訳品質チェッカー
 */
export class TranslationChecker {
	private md: MarkdownIt;

	constructor() {
		this.md = new MarkdownIt();
	}

	/**
	 * 翻訳結果の品質をチェック
	 *
	 * @param sourceText 原文
	 * @param translatedText 訳文
	 * @returns チェック結果
	 */
	public checkTranslationQuality(sourceText: string, translatedText: string): TranslationCheckResult {
		const reasons: ReviewReason[] = [];

		// markdown-itでパースして構造を抽出
		const sourceStructure = this.extractStructure(sourceText);
		const translatedStructure = this.extractStructure(translatedText);

		// 見出し構造のチェック
		this.checkHeadings(sourceStructure, translatedStructure, reasons);

		// リスト項目数のチェック
		this.checkListItems(sourceStructure, translatedStructure, reasons);

		// コードブロック数のチェック
		this.checkCodeBlocks(sourceStructure, translatedStructure, reasons);

		// 引用ブロック数のチェック
		this.checkBlockquotes(sourceStructure, translatedStructure, reasons);

		// テーブル数のチェック
		this.checkTables(sourceStructure, translatedStructure, reasons);

		// リンク数のチェック
		this.checkLinks(sourceStructure, translatedStructure, reasons);

		// 画像数のチェック
		this.checkImages(sourceStructure, translatedStructure, reasons);

		return {
			needsReview: reasons.length > 0,
			reasons,
		};
	}

	/**
	 * markdown-itでパースしてMarkdown構造を抽出
	 * @param text Markdownテキスト
	 * @returns Markdown構造
	 */
	private extractStructure(text: string): MarkdownStructure {
		const tokens = this.md.parse(text, {});
		const structure: MarkdownStructure = {
			headings: new Map<number, number>(),
			listItems: 0,
			codeBlocks: 0,
			blockquotes: 0,
			tables: 0,
			links: 0,
			images: 0,
		};

		for (const token of tokens) {
			switch (token.type) {
				case "heading_open": {
					// 見出しレベル（h1, h2, ...からレベルを抽出）
					const level = Number.parseInt(token.tag.substring(1));
					structure.headings.set(level, (structure.headings.get(level) || 0) + 1);
					break;
				}
				case "list_item_open":
					structure.listItems++;
					break;
				case "fence":
				case "code_block":
					structure.codeBlocks++;
					break;
				case "blockquote_open":
					structure.blockquotes++;
					break;
				case "table_open":
					structure.tables++;
					break;
			}

			// インライン要素内のリンクと画像をカウント
			if (token.type === "inline" && token.children) {
				for (const child of token.children) {
					if (child.type === "link_open") {
						structure.links++;
					} else if (child.type === "image") {
						structure.images++;
					}
				}
			}
		}

		return structure;
	}

	/**
	 * 見出し構造をチェック
	 */
	private checkHeadings(
		source: MarkdownStructure,
		translated: MarkdownStructure,
		reasons: ReviewReason[],
	): void {
		// 各レベルの見出し数を比較
		const allLevels = new Set([...source.headings.keys(), ...translated.headings.keys()]);

		for (const level of allLevels) {
			const sourceCount = source.headings.get(level) || 0;
			const translatedCount = translated.headings.get(level) || 0;

			if (sourceCount !== translatedCount) {
				reasons.push({
					category: "heading_mismatch",
					message: `見出しレベル${level}の数が不一致: 原文${sourceCount}個 vs 訳文${translatedCount}個`,
				});
			}
		}
	}

	/**
	 * リスト項目数をチェック
	 */
	private checkListItems(
		source: MarkdownStructure,
		translated: MarkdownStructure,
		reasons: ReviewReason[],
	): void {
		if (source.listItems !== translated.listItems) {
			reasons.push({
				category: "list_mismatch",
				message: `リスト項目数が不一致: 原文${source.listItems}項目 vs 訳文${translated.listItems}項目`,
			});
		}
	}

	/**
	 * コードブロック数をチェック
	 */
	private checkCodeBlocks(
		source: MarkdownStructure,
		translated: MarkdownStructure,
		reasons: ReviewReason[],
	): void {
		if (source.codeBlocks !== translated.codeBlocks) {
			reasons.push({
				category: "code_block_mismatch",
				message: `コードブロック数が不一致: 原文${source.codeBlocks}個 vs 訳文${translated.codeBlocks}個`,
			});
		}
	}

	/**
	 * 引用ブロック数をチェック
	 */
	private checkBlockquotes(
		source: MarkdownStructure,
		translated: MarkdownStructure,
		reasons: ReviewReason[],
	): void {
		if (source.blockquotes !== translated.blockquotes) {
			reasons.push({
				category: "blockquote_mismatch",
				message: `引用ブロック数が不一致: 原文${source.blockquotes}個 vs 訳文${translated.blockquotes}個`,
			});
		}
	}

	/**
	 * テーブル数をチェック
	 */
	private checkTables(
		source: MarkdownStructure,
		translated: MarkdownStructure,
		reasons: ReviewReason[],
	): void {
		if (source.tables !== translated.tables) {
			reasons.push({
				category: "table_mismatch",
				message: `テーブル数が不一致: 原文${source.tables}個 vs 訳文${translated.tables}個`,
			});
		}
	}

	/**
	 * リンク数をチェック
	 */
	private checkLinks(
		source: MarkdownStructure,
		translated: MarkdownStructure,
		reasons: ReviewReason[],
	): void {
		if (source.links !== translated.links) {
			reasons.push({
				category: "link_mismatch",
				message: `リンク数が不一致: 原文${source.links}個 vs 訳文${translated.links}個`,
			});
		}
	}

	/**
	 * 画像数をチェック
	 */
	private checkImages(
		source: MarkdownStructure,
		translated: MarkdownStructure,
		reasons: ReviewReason[],
	): void {
		if (source.images !== translated.images) {
			reasons.push({
				category: "image_mismatch",
				message: `画像数が不一致: 原文${source.images}個 vs 訳文${translated.images}個`,
			});
		}
	}
}
