/**
 * @file verify-response-validator.ts
 * @description
 *   AIペアリング検証レスポンスのバリデーション。
 *   JSON抽出・型検証は trans/response-validator.ts のパターンを踏襲する。
 *   VS Code API 非依存。
 * @module commands/ai-sync/verify-response-validator
 */

import { extractJsonFromResponse } from "../trans/response-validator";
import type { ValidationError, ValidationResult } from "../trans/response-validator";
import { PAIR_VERDICTS, type PairVerdict, type ParsedVerifyResponse } from "./review-result";

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * confidence を 0..1 にクランプする
 */
function clampConfidence(value: number): number {
	if (Number.isNaN(value)) {
		return 0;
	}
	return Math.min(1, Math.max(0, value));
}

/**
 * verdict オブジェクト1件分をバリデートする（単ペア応答・バッチ応答の各要素で共用）。
 */
function validateVerdictObject(parsed: unknown): ValidationResult<ParsedVerifyResponse> {
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

	if (typeof parsed.verdict !== "string" || !PAIR_VERDICTS.includes(parsed.verdict as PairVerdict)) {
		return {
			valid: false,
			error: {
				code: "INVALID_FIELD_TYPE",
				message: `Invalid 'verdict' field: expected one of ${PAIR_VERDICTS.join(", ")}`,
				retryable: true,
			},
		};
	}

	if (typeof parsed.confidence !== "number") {
		return {
			valid: false,
			error: {
				code: "MISSING_REQUIRED_FIELD",
				message: "Missing or invalid 'confidence' field (must be a number)",
				retryable: true,
			},
		};
	}

	const issues = Array.isArray(parsed.issues)
		? parsed.issues.filter((item): item is string => typeof item === "string")
		: [];
	const reason = typeof parsed.reason === "string" ? parsed.reason : "";

	return {
		valid: true,
		parsed: {
			verdict: parsed.verdict as PairVerdict,
			confidence: clampConfidence(parsed.confidence),
			issues,
			reason,
		},
	};
}

/**
 * AIペアリング検証レスポンス（単ペア）をバリデートする。
 * verdict 語彙外・confidence 欠落はリトライ可能エラーとして返す。
 */
export function validateVerifyResponse(rawResponse: string): ValidationResult<ParsedVerifyResponse> {
	const jsonString = extractJsonFromResponse(rawResponse);

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

	return validateVerdictObject(parsed);
}

/** バッチ検証応答のバリデーション結果 */
export interface BatchValidationResult {
	/** index → 検証済み応答（部分的に有効なエントリも含む） */
	entries: Map<number, ParsedVerifyResponse>;
	/** 応答全体の不正・エントリ欠落/不正がある場合に設定（retryable） */
	error?: ValidationError;
}

/**
 * AIペアリング検証レスポンス（バッチ）をバリデートする。
 *
 * - 応答は `{"results": [{"index": 1, "verdict": ...}, ...]}` 形式を要求する
 *   （extractJsonFromResponse がオブジェクト `{...}` のみ抽出するため配列にはしない）
 * - 有効なエントリは entries に残す（重複 index は最初を採用、期待外 index は無視）
 * - expectedIndices が全て揃わなければ retryable error を設定する（欠落 index を列挙）。
 *   呼び出し側はリトライ枯渇時に entries を部分受理できる。
 */
export function validateVerifyBatchResponse(
	rawResponse: string,
	expectedIndices: readonly number[],
): BatchValidationResult {
	const jsonString = extractJsonFromResponse(rawResponse);

	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonString);
	} catch (e) {
		return {
			entries: new Map(),
			error: {
				code: "JSON_PARSE_ERROR",
				message: `JSON parse failed: ${e instanceof Error ? e.message : String(e)}`,
				retryable: true,
			},
		};
	}

	if (!isObject(parsed) || !Array.isArray(parsed.results)) {
		return {
			entries: new Map(),
			error: {
				code: "INVALID_FIELD_TYPE",
				message: 'Response must be an object with a "results" array',
				retryable: true,
			},
		};
	}

	const expected = new Set(expectedIndices);
	const entries = new Map<number, ParsedVerifyResponse>();
	for (const item of parsed.results) {
		if (!isObject(item) || typeof item.index !== "number") {
			continue;
		}
		const index = Math.floor(item.index);
		if (!expected.has(index) || entries.has(index)) {
			continue;
		}
		const validation = validateVerdictObject(item);
		if (validation.valid && validation.parsed) {
			entries.set(index, validation.parsed);
		}
	}

	const missing = expectedIndices.filter((index) => !entries.has(index));
	if (missing.length > 0) {
		return {
			entries,
			error: {
				code: "MISSING_REQUIRED_FIELD",
				message: `"results" is missing valid entries for indices: ${missing.join(", ")}`,
				retryable: true,
			},
		};
	}

	return { entries };
}
