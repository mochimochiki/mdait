/**
 * @file response-validator.ts
 * @description AIレスポンスのバリデーションを行うモジュール
 *
 * JSONパース、スキーマ検証、コンテンツ内JSON混入検出を行い、
 * 不正なレスポンスを検出してリトライ判断の基礎情報を提供する。
 */

import { lineNumberPatchSyntaxError, patchEchoesLineNumbers } from "../../core/diff/diff-generator";
import type { TermSuggestion } from "./translator";
import { NO_CHANGE_ANSWER, splitBatchResponse } from "./unit-batch";

/**
 * バリデーション結果
 */
export interface ValidationResult<T> {
	/** バリデーション成功フラグ */
	valid: boolean;
	/** パース済みデータ（valid=true時のみ） */
	parsed?: T;
	/** エラー詳細（valid=false時のみ） */
	error?: ValidationError;
}

/**
 * バリデーションエラー詳細
 */
export interface ValidationError {
	/** エラーコード */
	code: ValidationErrorCode;
	/** エラーメッセージ */
	message: string;
	/** リトライ可能か */
	retryable: boolean;
}

/**
 * バリデーションエラーコード
 */
export type ValidationErrorCode =
	| "JSON_PARSE_ERROR" // JSONパース失敗
	| "MISSING_REQUIRED_FIELD" // 必須フィールド欠落
	| "INVALID_FIELD_TYPE" // フィールド型不正
	| "JSON_IN_CONTENT" // コンテンツ内にJSON混入
	| "NESTED_JSON" // ネストされたJSON構造
	| "EMPTY_RESPONSE" // answer が空（素のテキストで受けるときに使う）
	| "LINE_NUMBER_ECHO" // 行番号方式で、渡した行番号を本文へ書き戻した（専用の案内へつなぐため分ける）
	| "UNIT_SEPARATOR_MISMATCH"; // まとめて頼んだ翻訳で、ユニットの区切りの行がそろっていない

/**
 * 翻訳レスポンスの内部表現
 */
export interface ParsedTranslationResponse {
	translation: string;
	termSuggestions?: TermSuggestion[];
	warnings?: string[];
}

/**
 * 改訂パッチレスポンスの内部表現
 */
export interface ParsedRevisionPatchResponse {
	targetPatch: string;
	termSuggestions?: TermSuggestion[];
	warnings?: string[];
}

/**
 * JSON検出結果
 */
export interface JsonDetectionResult {
	detected: boolean;
	pattern?: string;
}

/**
 * レスポンスからJSON部分を抽出
 *
 * **オブジェクト `{...}` と配列 `[...]` の両方を拾う。** 配列を待つ経路（TM登録計画）で
 * フェンスを剥がせず、`[]` のうしろに説明文を書いた応答を丸ごと落としていた
 * （実測: haiku が「```json\n[]\n```\n\n**Rationale:** …」と答え、tm.commit が
 * `Failed to parse LLM alignment response` で件数0のまま無言で終わった）。
 * フェンスの外にある前置き・後書きは、ここで一緒に落ちる。
 *
 * @param rawResponse AIからの生レスポンス
 * @returns 抽出されたJSON文字列
 */
export function extractJsonFromResponse(rawResponse: string): string {
	// パターン1: ```json ... ``` または ``` ... ```
	const codeBlockMatch = rawResponse.match(/```(?:json)?\s*(\{[\s\S]*?\}|\[[\s\S]*?\])\s*```/);
	if (codeBlockMatch) {
		return codeBlockMatch[1];
	}
	// パターン2: 生のJSON
	return rawResponse.trim();
}

/**
 * 修復して読めた結果に許すキー。
 *
 * 修復は「どの `"` が閉じか」を推し量るので、取り違えると別の形のオブジェクトが読めてしまう。
 * 知らないキーが混ざっていたら取り違えたとみなし、修復した結果を使わない。
 */
export interface LenientShape {
	/** トップレベルのオブジェクトに許すキー */
	topLevelKeys: readonly string[];
	/** termSuggestions の各要素に許すキー */
	termSuggestionKeys: readonly string[];
}

/** termSuggestions の要素に許すキー（`TermSuggestion` の定義と同じ） */
const TERM_SUGGESTION_KEYS = [
	"source",
	"target",
	"context",
	"reason",
] as const satisfies readonly (keyof TermSuggestion)[];

/** 翻訳の答えに許すキー（`ParsedTranslationResponse` の定義と同じ） */
const TRANSLATION_SHAPE: LenientShape = {
	topLevelKeys: [
		"translation",
		"termSuggestions",
		"warnings",
	] as const satisfies readonly (keyof ParsedTranslationResponse)[],
	termSuggestionKeys: TERM_SUGGESTION_KEYS,
};

/** 改訂パッチの答えに許すキー（`ParsedRevisionPatchResponse` の定義と同じ） */
const REVISION_PATCH_SHAPE: LenientShape = {
	topLevelKeys: [
		"targetPatch",
		"termSuggestions",
		"warnings",
	] as const satisfies readonly (keyof ParsedRevisionPatchResponse)[],
	termSuggestionKeys: TERM_SUGGESTION_KEYS,
};

/**
 * JSON として読む。読めなければ、文字列の中の書き損じを直してからもう一度だけ読む。
 *
 * **直すのは文字列リテラルの中だけで、封筒の形には手を付けない。** 直したあとも
 * 読めなければ、最初の失敗をそのまま投げる（読めない理由を取り違えないため）。
 *
 * 直して読めても、次のどちらかなら閉じの取り違えとみなし、やはり最初の失敗を投げる。
 * - `shape` を渡したとき、知らないキーが混ざっている
 * - キーと値の区切りのような並び（`": "`）の `"` を、文字列の中身としてエスケープした
 * - 配列の中で、どこで閉じるかが一意に決まらない `"` があった
 *
 * @param jsonString `extractJsonFromResponse` で取り出した文字列
 * @param shape 修復した結果に許すキー。省略時はキーを確かめない
 * @returns パース結果
 * @throws 直しても読めないとき、最初の `JSON.parse` の例外
 */
export function parseJsonLenient(jsonString: string, shape?: LenientShape): unknown {
	try {
		return JSON.parse(jsonString);
	} catch (strictError) {
		const repair = repairJsonStringLiteralsDetailed(jsonString);
		if (repair.text === jsonString || repair.escapedKeyLike || repair.ambiguous) {
			throw strictError;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(repair.text);
		} catch {
			throw strictError;
		}
		if (shape && !matchesShape(parsed, shape)) {
			throw strictError;
		}
		return parsed;
	}
}

/** トップレベルのキーと termSuggestions の要素のキーが、許したものだけかを答える */
function matchesShape(value: unknown, shape: LenientShape): boolean {
	if (!isObject(value)) {
		return true;
	}
	if (!Object.keys(value).every((key) => shape.topLevelKeys.includes(key))) {
		return false;
	}
	const suggestions = value.termSuggestions;
	if (!Array.isArray(suggestions)) {
		return true;
	}
	return suggestions.every(
		(item) => !isObject(item) || Object.keys(item).every((key) => shape.termSuggestionKeys.includes(key)),
	);
}

/**
 * JSON の文字列リテラルの中で、エスケープされていない `"` と改行・タブをエスケープし直す。
 *
 * 実測（Haiku 4.5・日本語→簡体字中国語）では、訳文と termSuggestions の中で
 * 「」を `"设置画面"` のような ASCII の `"` に置き換え、エスケープせずに返した。
 * 生の改行を文字列に入れた返答もあった。どちらも中身は正しく、封筒だけが読めない。
 * やり直しても同じ書き方を繰り返すので、送り直しでは直らない。
 *
 * 文字列の中の `"` は、直後（空白を飛ばす）がその位置で閉じたときに来るべき並びの
 * ときだけ閉じとみなす。キーなら `:`、値なら入れ物の閉じ（オブジェクトの中は `}`、配列の中は `]`）、
 * または `,` のあとに次の要素が続くとき。`,` のあとの文字列は閉じの `"` まで先読みし、
 * オブジェクトの中ならその直後が `:` であること（次のキーであること）、配列の中なら `,` か `]`
 * であること（次の要素として完結すること）まで確かめる。値の中の `"OK", "Cancel"` や
 * `["Low"]` を閉じと取り違えないためである。それ以外は文字列の中身として `\"` に書き換える。
 *
 * @param text 読めなかった JSON 文字列
 * @returns 書き換えた文字列。直す箇所が無ければ入力そのもの
 */
export function repairJsonStringLiterals(text: string): string {
	return repairJsonStringLiteralsDetailed(text).text;
}

interface RepairResult {
	text: string;
	/** キーと値の区切りのような並び（`": "`）の `"` を、中身としてエスケープしたか */
	escapedKeyLike: boolean;
	/**
	 * 配列の中で、閉じが一意に決まらない `"` があったか。
	 *
	 * `["Choose "OK", "Cancel"]` は、1件（`Choose "OK", "Cancel"`）とも2件（`Choose "OK` と
	 * `Cancel`）とも読める。2件として閉じると、その要素の中にエスケープした `"` が奇数個残る。
	 * どちらが正しいかを決める手がかりが無いので、この形を見たら修復を採用しない。
	 */
	ambiguous: boolean;
}

function repairJsonStringLiteralsDetailed(text: string): RepairResult {
	let out = "";
	let escapedKeyLike = false;
	let ambiguous = false;
	// 開いている入れ子（"{" か "["）。キーの位置かどうかの判定に使う
	const stack: string[] = [];
	// オブジェクトの中で、次に来る文字列がキーかどうか
	let expectingKey = false;
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		if (ch !== '"') {
			if (ch === "{") {
				stack.push("{");
				expectingKey = true;
			} else if (ch === "[") {
				stack.push("[");
				expectingKey = false;
			} else if (ch === "}" || ch === "]") {
				stack.pop();
				expectingKey = false;
			} else if (ch === ",") {
				expectingKey = stack[stack.length - 1] === "{";
			} else if (ch === ":") {
				expectingKey = false;
			}
			out += ch;
			i++;
			continue;
		}

		// 文字列リテラルを読む
		const isKey = expectingKey;
		const container = stack[stack.length - 1];
		// この文字列の中で、中身としてエスケープした `"` の数
		let escapedQuotes = 0;
		out += '"';
		i++;
		while (i < text.length) {
			const c = text[i];
			if (c === "\\") {
				out += c + (text[i + 1] ?? "");
				i += 2;
				continue;
			}
			if (c === "\n") {
				out += "\\n";
				i++;
				continue;
			}
			if (c === "\r") {
				out += "\\r";
				i++;
				continue;
			}
			if (c === "\t") {
				out += "\\t";
				i++;
				continue;
			}
			if (c === '"') {
				if (closesString(text, i + 1, isKey, container)) {
					if (
						container === "[" &&
						escapedQuotes % 2 === 1 &&
						text[skipWhitespace(text, i + 1)] === ","
					) {
						ambiguous = true;
					}
					break;
				}
				if (/^\s*:\s*"/.test(text.slice(i + 1, i + 64))) {
					escapedKeyLike = true;
				}
				escapedQuotes++;
				out += '\\"';
				i++;
				continue;
			}
			out += c;
			i++;
		}
		if (i < text.length) {
			out += '"';
			i++;
		}
		expectingKey = false;
	}
	return { text: out, escapedKeyLike, ambiguous };
}

/** `"` の直後（`from` 以降）が、文字列がそこで閉じたときに来るべき並びかを答える */
function closesString(text: string, from: number, isKey: boolean, container: string | undefined): boolean {
	const next = skipWhitespace(text, from);
	if (next >= text.length) {
		return true;
	}
	const c = text[next];
	if (isKey) {
		return c === ":";
	}
	if (container === undefined) {
		return false;
	}
	// 入れ物の閉じは、その入れ物の中の文字列のときだけ。オブジェクトの値の中の `["Low"]` の `]` で閉じない
	if (c === "}" || c === "]") {
		return (c === "}" && container === "{") || (c === "]" && container === "[");
	}
	if (c !== ",") {
		return false;
	}
	const after = skipWhitespace(text, next + 1);
	const n = text[after];
	if (container === "{") {
		// オブジェクトの中なら、次はキー。閉じの `"` の直後が `:` であるところまで確かめる
		if (n === "}") {
			return true;
		}
		return n === '"' && isFollowedByColon(text, after + 1);
	}
	// 配列の中の文字列なら、次の要素も文字列で、閉じの `"` の直後が `,` か `]`（要素として完結する）
	return n === '"' && isFollowedBy(text, after + 1, [",", "]"]);
}

/** `from` から次の閉じの `"` まで読み、その直後（空白を飛ばす）が `:` かを答える */
function isFollowedByColon(text: string, from: number): boolean {
	return isFollowedBy(text, from, [":"]);
}

/** `from` から次の閉じの `"` まで読み、その直後（空白を飛ばす）が `expected` のどれかかを答える */
function isFollowedBy(text: string, from: number, expected: readonly string[]): boolean {
	let i = from;
	while (i < text.length) {
		const c = text[i];
		if (c === "\\") {
			i += 2;
			continue;
		}
		if (c === "\n") {
			return false;
		}
		if (c === '"') {
			return expected.includes(text[skipWhitespace(text, i + 1)]);
		}
		i++;
	}
	return false;
}

function skipWhitespace(text: string, from: number): number {
	let i = from;
	while (i < text.length && /\s/.test(text[i])) {
		i++;
	}
	return i;
}

/**
 * オブジェクト型ガード
 */
function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * コンテンツ内のJSON混入を検出
 * @param text 検査対象テキスト
 * @returns 検出結果
 */
export function detectJsonInContent(text: string): JsonDetectionResult {
	// パターン1: {"translation": "..."} または {"targetPatch": "..."} ラッパー検出
	const wrapperPattern = /\{\s*"(?:translation|targetPatch)"\s*:\s*"/;
	if (wrapperPattern.test(text)) {
		return {
			detected: true,
			pattern: "AI response wrapper structure detected in content",
		};
	}

	// パターン2: 行頭から始まる完全なJSONオブジェクト
	const jsonObjectPattern = /^\s*\{[^}]*"[^"]+"\s*:\s*(?:"[^"]*"|[\d.]+|true|false|null|\[|\{)/m;
	if (jsonObjectPattern.test(text)) {
		return {
			detected: true,
			pattern: "JSON object structure detected in content",
		};
	}

	// パターン3: エスケープされたJSON
	const escapedJsonPattern = /\\"\w+\\":\s*\\"/;
	if (escapedJsonPattern.test(text)) {
		return {
			detected: true,
			pattern: "Escaped JSON structure detected in content",
		};
	}

	return { detected: false };
}

/**
 * バリデーションのオプション
 */
export interface ValidateOptions {
	/**
	 * 本文への JSON 混入を検出するか。既定は true。
	 *
	 * **JSON そのものを訳すとき（.json / JSON の例を含む .txt など）は false にする。**
	 * この検出は「AI が応答のエンベロープを本文へ漏らした」を捕まえる道具なので、
	 * 訳す対象が JSON だと定義上つねに当たってしまう。Markdown ではフェンス付き
	 * コードブロックが先に退避されるため、この偽陽性は起きない。
	 *
	 * 以前は偽陽性のたびに送り直し（3回）→ フォールバックへ落ちており、
	 * フォールバックは生応答をそのまま訳文にしていた。つまり .json ファイルの翻訳は
	 * 毎回3倍の費用を払ったうえで `{"translation": "…"}` を丸ごと書き込んでいた。
	 */
	detectJsonInContent?: boolean;
}

/**
 * 翻訳レスポンスをバリデート
 * @param rawResponse AIからの生レスポンス
 * @param options 検出の切り替え
 * @returns バリデーション結果
 */
export function validateTranslationResponse(
	rawResponse: string,
	options?: ValidateOptions,
): ValidationResult<ParsedTranslationResponse> {
	// Step 1: マークダウンコードブロック除去
	const jsonString = extractJsonFromResponse(rawResponse);

	// Step 2: JSONパース
	let parsed: unknown;
	try {
		parsed = parseJsonLenient(jsonString, TRANSLATION_SHAPE);
	} catch (e) {
		return {
			valid: false,
			error: {
				code: "JSON_PARSE_ERROR",
				message: `JSON parse failed: ${e instanceof Error ? e.message : String(e)}`,
				retryable: true,
			},
		};
	}

	// Step 3: スキーマ検証
	if (!isObject(parsed)) {
		return {
			valid: false,
			error: {
				code: "INVALID_FIELD_TYPE",
				message: "Response must be an object",
				retryable: true,
			},
		};
	}

	if (!("translation" in parsed) || typeof parsed.translation !== "string") {
		return {
			valid: false,
			error: {
				code: "MISSING_REQUIRED_FIELD",
				message: "Missing or invalid 'translation' field",
				retryable: true,
			},
		};
	}

	// Step 4: translationフィールド内のJSON混入検出
	const jsonInContent =
		options?.detectJsonInContent === false ? { detected: false } : detectJsonInContent(parsed.translation);
	if (jsonInContent.detected) {
		return {
			valid: false,
			error: {
				code: "JSON_IN_CONTENT",
				message: `JSON structure detected in translation: ${jsonInContent.pattern}`,
				retryable: true,
			},
		};
	}

	return {
		valid: true,
		parsed: {
			translation: parsed.translation,
			termSuggestions: sanitizeTermSuggestions(parsed.termSuggestions),
			warnings: Array.isArray(parsed.warnings) ? parsed.warnings : undefined,
		},
	};
}

/**
 * AI が返した用語候補を、使える形のものだけに絞る。
 *
 * **翻訳そのものを巻き添えにしない。** 用語候補は翻訳の応答に相乗りしているおまけで、
 * ここが崩れていても訳文は使える。1件でも形が違えば応答ごと捨てる作りにすると、
 * 良い訳文を「おまけが壊れていた」という理由で捨てることになる。
 *
 * 以前は配列かどうかしか見ずに `TermSuggestion[]` として通していた。実測（haiku・
 * 対訳47ファイルの見本サイト）で `source` の無い候補が返り、受け手の
 * `candidate.source.toLowerCase()` が**ファイル1本の翻訳ごと**落とした。
 * 型が「必ずある」と言っているのに、その保証をどこも作っていなかった。
 *
 * `context` は引用で、無くても用語としては使える。**引用が無いだけで用語を捨てない** —
 * 用語集の文脈欄が空になるだけである。
 *
 * 落とした候補は黙って消える。件数はもともと AI 次第で増減するものなので、
 * 「何件落とした」を伝えても読み手が判断に使えない。
 *
 * @param raw AI 応答の termSuggestions（未検証）
 * @returns 配列でなければ `undefined`、配列なら使える候補だけの配列（空もありうる）
 */
export function sanitizeTermSuggestions(raw: unknown): TermSuggestion[] | undefined {
	if (!Array.isArray(raw)) {
		return undefined;
	}
	const suggestions: TermSuggestion[] = [];
	for (const item of raw) {
		if (typeof item !== "object" || item === null) {
			continue;
		}
		const candidate = item as Record<string, unknown>;
		const source = candidate.source;
		const target = candidate.target;
		if (typeof source !== "string" || source.trim() === "") {
			continue;
		}
		if (typeof target !== "string" || target.trim() === "") {
			continue;
		}
		suggestions.push({
			source,
			target,
			context: typeof candidate.context === "string" ? candidate.context : "",
			...(typeof candidate.reason === "string" ? { reason: candidate.reason } : {}),
		});
	}
	return suggestions;
}

/** 前後のコードフェンスを剥がす。指示文で禁じていてもモデルは包んでくることがある */
function stripCodeFence(text: string): string {
	const trimmed = text.trim();
	const match = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(trimmed);
	return match ? match[1] : trimmed;
}

/** 行番号方式の指示ブロックの見出し */
const LINE_OP_HEAD = /^\s*(REPLACE\s+\d|INSERT\s+AFTER\s+\d|DELETE\s+\d)/im;

/**
 * 行番号方式（素のテキスト）の改訂パッチをバリデートする。
 *
 * JSON の封筒を使わないので、`validateRevisionPatchResponse` とは別の入口にする。
 * **ここで形を確かめるのは、当てはめる前にやり直しを頼めるようにするため。** 当てはめ器も
 * 同じ失敗を返せるが、そこまで行くとリトライの機会が無い。
 */
export function validateRevisionPatchPlainResponse(rawResponse: string): ValidationResult<ParsedRevisionPatchResponse> {
	const body = stripCodeFence(rawResponse ?? "");
	if (!body.trim()) {
		return {
			valid: false,
			error: { code: "EMPTY_RESPONSE", message: "The answer was empty", retryable: true },
		};
	}
	// JSON で返してきたら指示に従っていない（素のテキストを求めている）
	if (/^\s*\{\s*"\w+"\s*:/.test(body)) {
		return {
			valid: false,
			error: {
				code: "JSON_IN_CONTENT",
				message: "The answer was JSON, but plain edit blocks were requested",
				retryable: true,
			},
		};
	}
	if (!LINE_OP_HEAD.test(body)) {
		return {
			valid: false,
			error: {
				code: "INVALID_FIELD_TYPE",
				message: "The answer contained no REPLACE / INSERT AFTER / DELETE block",
				retryable: true,
			},
		};
	}
	// **渡した行番号を本文に書き戻していたら、当てる前にもう一度聞く。**
	// 当てはめ器から見れば正しいパッチなので、ここで気づかないと番号ごと訳文へ入る
	// （ADR-260908-05。実測で qwen3.6-35B-A3B に 36件中1件出た）
	if (patchEchoesLineNumbers(body)) {
		return {
			valid: false,
			error: {
				code: "LINE_NUMBER_ECHO",
				message: "The answer repeated the line numbers inside an edit block",
				retryable: true,
			},
		};
	}
	// 用語候補は改訂では集めない（ADR-260903-01。測った指示文に含まれていない）
	return { valid: true, parsed: { targetPatch: body, termSuggestions: [], warnings: [] } };
}

/**
 * 改訂パッチレスポンスをバリデート
 * @param rawResponse AIからの生レスポンス
 * @param options 検出の切り替え
 * @returns バリデーション結果
 */
export function validateRevisionPatchResponse(
	rawResponse: string,
	options?: ValidateOptions,
): ValidationResult<ParsedRevisionPatchResponse> {
	// Step 1: マークダウンコードブロック除去
	const jsonString = extractJsonFromResponse(rawResponse);

	// Step 2: JSONパース
	let parsed: unknown;
	try {
		parsed = parseJsonLenient(jsonString, REVISION_PATCH_SHAPE);
	} catch (e) {
		return {
			valid: false,
			error: {
				code: "JSON_PARSE_ERROR",
				message: `JSON parse failed: ${e instanceof Error ? e.message : String(e)}`,
				retryable: true,
			},
		};
	}

	// Step 3: スキーマ検証
	if (!isObject(parsed)) {
		return {
			valid: false,
			error: {
				code: "INVALID_FIELD_TYPE",
				message: "Response must be an object",
				retryable: true,
			},
		};
	}

	if (!("targetPatch" in parsed) || typeof parsed.targetPatch !== "string") {
		return {
			valid: false,
			error: {
				code: "MISSING_REQUIRED_FIELD",
				message: "Missing or invalid 'targetPatch' field",
				retryable: true,
			},
		};
	}

	// Step 4: targetPatchフィールド内のJSON混入検出
	const jsonInContent =
		options?.detectJsonInContent === false ? { detected: false } : detectJsonInContent(parsed.targetPatch);
	if (jsonInContent.detected) {
		return {
			valid: false,
			error: {
				code: "JSON_IN_CONTENT",
				message: `JSON structure detected in targetPatch: ${jsonInContent.pattern}`,
				retryable: true,
			},
		};
	}

	return {
		valid: true,
		parsed: {
			targetPatch: parsed.targetPatch,
			termSuggestions: sanitizeTermSuggestions(parsed.termSuggestions),
			warnings: Array.isArray(parsed.warnings) ? parsed.warnings : undefined,
		},
	};
}

/**
 * まとめて頼んだ翻訳（素のテキスト。`trans.translateBatch`）をバリデートする（ADR-261109-01）。
 *
 * 答えをユニットへ分けられるかをここで確かめる。分けられない答えを受け取ってから気づくと、
 * やり直しを頼む機会が無い。通ったときは、包んでいたコードフェンスを剥がした本文を返す。
 *
 * @param rawResponse AI の生の答え
 * @param count まとめたユニットの数
 */
export function validateBatchTranslationResponse(rawResponse: string, count: number): ValidationResult<string> {
	const body = stripCodeFence(rawResponse ?? "");
	if (!body.trim()) {
		return {
			valid: false,
			error: { code: "EMPTY_RESPONSE", message: "The answer was empty", retryable: true },
		};
	}
	// JSON で返してきたら指示に従っていない（素のテキストを求めている）
	if (/^\s*\{\s*"\w+"\s*:/.test(body)) {
		return {
			valid: false,
			error: {
				code: "JSON_IN_CONTENT",
				message: "The answer was JSON, but plain Markdown was requested",
				retryable: true,
			},
		};
	}
	if (!splitBatchResponse(body, count)) {
		return {
			valid: false,
			error: {
				code: "UNIT_SEPARATOR_MISMATCH",
				message: `The answer did not contain the ${count} unit separator lines (@@@ UNIT 1 @@@ to @@@ UNIT ${count} @@@) in order, each followed by a non-empty translation`,
				retryable: true,
			},
		};
	}
	return { valid: true, parsed: body };
}

/**
 * まとめて頼んだ改訂（素のテキスト。`trans.revisePatchBatch`）をバリデートする（ADR-261110-01）。
 *
 * 区切りの行でユニットに分け、各ユニットの部分が `NO CHANGE` の1行か、行番号方式のパッチとして
 * 読めるかを確かめる。1つでも読めなければ、まとまり全体のやり直しを頼む。
 *
 * @returns 通ったときは、ユニットごとの答え（`NO CHANGE` か、パッチの本文）
 */
export function validateRevisionBatchResponse(rawResponse: string, count: number): ValidationResult<string[]> {
	const body = stripCodeFence(rawResponse ?? "");
	if (!body.trim()) {
		return {
			valid: false,
			error: { code: "EMPTY_RESPONSE", message: "The answer was empty", retryable: true },
		};
	}
	const parts = splitBatchResponse(body, count);
	if (!parts) {
		return {
			valid: false,
			error: {
				code: "UNIT_SEPARATOR_MISMATCH",
				message: `The answer did not contain the ${count} unit separator lines (@@@ UNIT 1 @@@ to @@@ UNIT ${count} @@@) in order, each followed by edit blocks or NO CHANGE`,
				retryable: true,
			},
		};
	}
	for (let i = 0; i < parts.length; i++) {
		if (parts[i].trim() === NO_CHANGE_ANSWER) {
			continue;
		}
		const unit = validateRevisionPatchPlainResponse(parts[i]);
		if (!unit.valid) {
			return {
				valid: false,
				error: {
					code: unit.error?.code ?? "INVALID_FIELD_TYPE",
					message: `Unit ${i + 1}: ${unit.error?.message ?? "invalid edit blocks"}`,
					retryable: unit.error?.retryable ?? true,
				},
			};
		}
		// 当てはめと同じ読み方で読めるかも確かめる。`END` の閉じ忘れを通すと、送り直しも
		// 1件ずつへの戻りも起きず、当てはめで落ちて need:revise が残る
		const syntaxError = lineNumberPatchSyntaxError(parts[i]);
		if (syntaxError) {
			return {
				valid: false,
				error: {
					code: "INVALID_FIELD_TYPE",
					message: `Unit ${i + 1}: the edit blocks could not be read (${syntaxError}). Close every block with a line containing only END`,
					retryable: true,
				},
			};
		}
	}
	return { valid: true, parsed: parts };
}
