/**
 * @file tm-text-normalizer.ts
 * @description
 *   翻訳メモリ（TM）の登録・検索時に使用するテキスト正規化処理。
 *   markdown-itを使用してMarkdownをパースし、純粋なテキストに変換する。
 *   翻訳価値のない短文・断片をフィルタリングする。
 * @module core/tm/tm-text-normalizer
 */

import MarkdownIt from "markdown-it";

/** markdown-itインスタンス（モジュールスコープで再利用） */
const md = new MarkdownIt("default");

/**
 * markdown-itトークンから純粋なテキストのみを抽出する。
 *
 * 処理方針：
 * - text, softbreak, hardbreak トークンのテキストを抽出
 * - code_inline, code_block, fence は除外（翻訳対象外）
 * - HTMLタグは後処理で除去
 * - 画像のaltテキストとリンクのテキストは抽出
 * - 段落間には空白を挿入
 * - 表のセル内容を抽出し、セル間にスペースを挿入
 *
 * @param tokens markdown-itトークン配列
 * @param isTopLevel トップレベルのトークン走査かどうか
 * @returns 抽出されたテキスト配列
 */
function extractTextFromTokens(tokens: MarkdownIt.Token[], isTopLevel = true): string[] {
	const textParts: string[] = [];
	let inParagraph = false;

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];

		// 段落の開始
		if (token.type === "paragraph_open") {
			inParagraph = true;
			// 段落の前にテキストがあれば空白を追加（段落間のスペース）
			if (textParts.length > 0 && isTopLevel) {
				textParts.push(" ");
			}
			continue;
		}

		// 段落の終了
		if (token.type === "paragraph_close") {
			inParagraph = false;
			continue;
		}

		// 表の開始（表の前にテキストがあればスペースを追加）
		if (token.type === "table_open") {
			if (textParts.length > 0 && isTopLevel) {
				textParts.push(" ");
			}
			continue;
		}

		// セルの終了（セル間にスペースを挿入、最終正規化で余分なスペースは除去される）
		if (token.type === "th_close" || token.type === "td_close") {
			textParts.push(" ");
			continue;
		}

		// 表の構造トークン（開始・終了）は無視（内容だけ抽出）
		if (
			token.type === "table_close" ||
			token.type === "thead_open" ||
			token.type === "thead_close" ||
			token.type === "tbody_open" ||
			token.type === "tbody_close" ||
			token.type === "tr_open" ||
			token.type === "tr_close" ||
			token.type === "th_open" ||
			token.type === "td_open"
		) {
			continue;
		}

		// インラインコード・コードブロックは除外
		if (token.type === "code_inline" || token.type === "code_block" || token.type === "fence") {
			continue;
		}

		// HTMLブロック・インラインHTMLはそのまま保持（後で正規表現除去）
		if (token.type === "html_block") {
			continue;
		}

		if (token.type === "html_inline") {
			// HTMLタグは後処理で除去するが、ここでは保持
			textParts.push(token.content);
			continue;
		}

		// テキストトークン
		if (token.type === "text") {
			textParts.push(token.content);
		}

		// 改行
		if (token.type === "softbreak" || token.type === "hardbreak") {
			textParts.push(" ");
		}

		// 子トークンを再帰的に処理（インライン要素）
		if (token.children && token.children.length > 0) {
			const childTexts = extractTextFromTokens(token.children, false);
			textParts.push(...childTexts);
		}
	}

	return textParts;
}

/**
 * Markdown要素を除去し、純粋なテキストに変換する。
 *
 * markdown-itでパースしてトークンツリーを走査し、テキストのみを抽出する。
 * コードブロック・インラインコード・HTMLタグは除外される。
 * リンクや画像は表示テキスト部分のみが抽出される。
 *
 * @param text Markdown付きテキスト
 * @returns 正規化されたプレーンテキスト
 *
 * @example
 * ```typescript
 * stripMarkdown("Hello **world**")  // => "Hello world"
 * stripMarkdown("[link](url)")      // => "link"
 * stripMarkdown("`code`")           // => ""
 * ```
 */
export function stripMarkdown(text: string): string {
	// 前処理：不正な位置のコードフェンスを除去（markdown-itが認識しない形式）
	// 例: "Text ```js\ncode\n```" → "Text "
	const preprocessed = text.replace(/```[\s\S]*?```/g, "");

	// markdown-itでパース
	const tokens = md.parse(preprocessed, {});

	// トークンからテキストを抽出
	const textParts = extractTextFromTokens(tokens);

	// 結合
	let result = textParts.join("");

	// HTMLタグを除去（markdown-itはHTMLをそのまま通すため）
	result = result.replace(/<[^>]+>/g, "");

	// 余分な空白を正規化（複数スペースを1つに、前後トリム）
	result = result.replace(/\s+/g, " ").trim();

	return result;
}

/**
 * 文がTM登録する価値があるかを判定する。
 *
 * 以下の条件のいずれかに該当する場合、翻訳価値なしと判断：
 * - 最小文字数未満（日本語8文字、英語12文字）
 * - 数値のみで構成される（例: "123", "3.14", "1,000"）
 * - URL・ファイルパスのみ
 * - 英語で2単語以下（短すぎるフレーズ）
 *
 * @param text Markdown除去済みテキスト
 * @param lang 言語コード（"ja", "en"など）
 * @returns 翻訳価値がある場合true
 *
 * @example
 * ```typescript
 * isWorthyForTm("short", "en")           // => false (12文字未満)
 * isWorthyForTm("Hello world", "en")     // => false (2単語以下)
 * isWorthyForTm("Hello world there", "en") // => true
 * isWorthyForTm("123", "en")             // => false (数値のみ)
 * isWorthyForTm("こんにちは", "ja")      // => false (8文字未満)
 * isWorthyForTm("これは良い文章です", "ja") // => true
 * ```
 */
export function isWorthyForTm(text: string, lang: string): boolean {
	const trimmed = text.trim();

	// 最小長チェック（言語別）
	const minLength = lang === "ja" ? 8 : 12;
	if (trimmed.length < minLength) {
		return false;
	}

	// 数値のみチェック（数値、カンマ、ドット、スペース、ハイフンのみ）
	if (/^[\d,.\s-]+$/.test(trimmed)) {
		return false;
	}

	// URL/パスのみチェック
	if (/^(https?:\/\/|\.\.?\/|\/)[^\s]+$/.test(trimmed)) {
		return false;
	}

	// 英語の場合、2単語以下は除外
	if (lang === "en") {
		const words = trimmed.split(/\s+/).filter((w) => w.length > 0);
		if (words.length <= 2) {
			return false;
		}
	}

	return true;
}
