/**
 * @file response-validator.ts
 * @description AIレスポンスのバリデーションを行うモジュール
 *
 * JSONパース、スキーマ検証、コンテンツ内JSON混入検出を行い、
 * 不正なレスポンスを検出してリトライ判断の基礎情報を提供する。
 */

import type { TermSuggestion } from "./translator";

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
	| "EMPTY_RESPONSE"; // answer が空（素のテキストで受けるときに使う）

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
		parsed = JSON.parse(jsonString);
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
		parsed = JSON.parse(jsonString);
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
