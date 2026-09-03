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

const LEADING_YAML_FRONTMATTER_PATTERN = /^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;
const BLOCK_SEPARATOR = "\n\n";

function appendTopLevelBlockSeparator(textParts: string[]): void {
	if (textParts.length === 0) {
		return;
	}

	const lastPart = textParts[textParts.length - 1];
	if (lastPart.endsWith("\n")) {
		textParts.push("\n");
		return;
	}

	textParts.push(BLOCK_SEPARATOR);
}

/**
 * markdown-itトークンから純粋なテキストのみを抽出する。
 *
 * 処理方針：
 * - text, softbreak, hardbreak トークンのテキストを抽出
 * - code_inline は保持し、code_block, fence は除外する
 * - HTMLタグは後処理で除去
 * - 画像のaltテキストとリンクのテキストは抽出
 * - トップレベルのブロック境界は改行2つで保持する
 * - 表のセル内容を抽出し、セルごとに改行で分離する
 *
 * @param tokens markdown-itトークン配列
 * @param isTopLevel トップレベルのトークン走査かどうか
 * @returns 抽出されたテキスト配列
 */
function extractTextFromTokens(tokens: MarkdownIt.Token[], isTopLevel = true): string[] {
	const textParts: string[] = [];

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];

		if (
			isTopLevel &&
			token.level === 0 &&
			(token.type === "heading_open" ||
				token.type === "blockquote_open" ||
				token.type === "paragraph_open" ||
				token.type === "bullet_list_open" ||
				token.type === "ordered_list_open" ||
				token.type === "table_open")
		) {
			appendTopLevelBlockSeparator(textParts);
		}

		// 見出しの後に改行2つ（段落との区別を明確化）
		if (token.type === "heading_close") {
			textParts.push(BLOCK_SEPARATOR);
			continue;
		}

		// リスト項目の後に改行1つ（項目間の区切り）
		if (token.type === "list_item_close") {
			textParts.push("\n");
			continue;
		}

		// 引用ブロックの後に改行2つ
		if (token.type === "blockquote_close") {
			textParts.push(BLOCK_SEPARATOR);
			continue;
		}

		// 区切り線（hr）の後に改行2つ
		if (token.type === "hr") {
			textParts.push(BLOCK_SEPARATOR);
			continue;
		}

		// 段落の開始
		if (token.type === "paragraph_open") {
			continue;
		}

		// 段落の終了
		if (token.type === "paragraph_close") {
			continue;
		}

		// 表の開始
		if (token.type === "table_open") {
			continue;
		}

		// セルの終了（セルごとに改行を挿入）
		if (token.type === "th_close" || token.type === "td_close") {
			textParts.push("\n");
			continue;
		}

		// 行の終了（行の終了処理）
		if (token.type === "tr_close") {
			// すでにセル終了で改行が入っているため、追加処理は不要
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
			token.type === "th_open" ||
			token.type === "td_open"
		) {
			continue;
		}

		// インラインコードは保持し、コードブロックのみ除外
		if (token.type === "code_inline") {
			textParts.push(`\`${token.content}\``);
			continue;
		}

		if (token.type === "code_block" || token.type === "fence") {
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

		// 画像はalt textも含めてスキップ（TM登録には不要）
		if (token.type === "image") {
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
 * 先頭のYAML frontmatterとコードブロック、HTMLタグは除外される。
 * インラインコードはバッククォート付きで保持される。
 * リンクや画像は表示テキスト部分のみが抽出される。
 *
 * @param text Markdown付きテキスト
 * @returns 正規化されたプレーンテキスト
 *
 * @example
 * ```typescript
 * stripMarkdown("Hello **world**")  // => "Hello world"
 * stripMarkdown("[link](url)")      // => "link"
 * stripMarkdown("`code`")           // => "`code`"
 * ```
 */
export function stripMarkdown(text: string): string {
	const withoutFrontmatter = text.replace(LEADING_YAML_FRONTMATTER_PATTERN, "");

	// 前処理：不正な位置のコードフェンスを除去（markdown-itが認識しない形式）
	// 例: "Text ```js\ncode\n```" → "Text "
	const preprocessed = withoutFrontmatter.replace(/```[\s\S]*?```/g, "");

	// markdown-itでパース
	const tokens = md.parse(preprocessed, {});

	// トークンからテキストを抽出
	const textParts = extractTextFromTokens(tokens);

	// 結合
	let result = textParts.join("");

	// HTMLタグを除去（markdown-itはHTMLをそのまま通すため）
	result = result.replace(/<[^>]+>/g, "");

	// 改行を保持した空白正規化
	// 改行以外の連続空白を1つに正規化
	result = result.replace(/[^\S\n]+/g, " ");

	// 改行の前後の空白を除去
	result = result.replace(/ *\n */g, "\n");

	// 連続する改行を最大2つに制限
	result = result.replace(/\n{3,}/g, "\n\n");

	// 先頭と末尾をトリム
	result = result.trim();

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

/**
 * テキストを trigram（3-gram）集合に変換する。
 *
 * Unicodeサロゲートペアに対応するため、[...text] でスプレッドして文字配列化する。
 * テキストが3文字未満の場合は空集合を返す（パディングなし）。
 *
 * @param text 正規化済みテキスト
 * @returns trigram の Set
 *
 * @example
 * ```typescript
 * computeTrigrams("hello")  // => Set { "hel", "ell", "llo" }
 * computeTrigrams("ab")     // => Set {} (3文字未満)
 * ```
 */
export function computeTrigrams(text: string): Set<string> {
	const chars = [...text];
	const trigrams = new Set<string>();
	for (let i = 0; i <= chars.length - 3; i++) {
		trigrams.add(chars[i] + chars[i + 1] + chars[i + 2]);
	}
	return trigrams;
}

/**
 * TM trigramインデックス・スコアリング用のテキスト正規化。
 * TmxStore（インデックス構築）とtm-ranker（スコアリング）で共有し、
 * インデックス構築時とスコアリング時のtrigramが常に一致することを保証する。
 *
 * @param text 正規化対象テキスト（Markdown含む可能性あり）
 * @returns stripMarkdown + toLowerCase + trim 適用後のテキスト
 */
export function normalizeForTm(text: string): string {
	return stripMarkdown(text).toLowerCase().trim();
}
