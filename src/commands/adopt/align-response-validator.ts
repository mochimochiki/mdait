/**
 * @file align-response-validator.ts
 * @description
 *   AIアライン応答（{ok | corrections | needBodies}）のバリデーション。
 *   JSON抽出は trans/response-validator.ts のパターンを踏襲する。
 *   VS Code API 非依存。ADR-260705-02。
 * @module commands/adopt/align-response-validator
 */

import { extractJsonFromResponse } from "../trans/response-validator";
import type { ValidationResult } from "../trans/response-validator";
import type { AlignCorrection, NeedBodyRef, ParsedAlignResponse } from "./align-result";

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCorrections(raw: unknown): AlignCorrection[] | null {
	if (!Array.isArray(raw)) {
		return null;
	}
	const corrections: AlignCorrection[] = [];
	for (const item of raw) {
		if (!isObject(item)) {
			return null;
		}
		if (typeof item.sourceIndex !== "number" || typeof item.targetIndex !== "number") {
			return null;
		}
		const confidence = typeof item.confidence === "number" ? item.confidence : 0;
		corrections.push({
			sourceIndex: item.sourceIndex,
			targetIndex: item.targetIndex,
			confidence,
		});
	}
	return corrections;
}

function parseNeedBodies(raw: unknown): NeedBodyRef[] | null {
	if (!Array.isArray(raw)) {
		return null;
	}
	const refs: NeedBodyRef[] = [];
	for (const item of raw) {
		if (!isObject(item)) {
			return null;
		}
		if ((item.side !== "source" && item.side !== "target") || typeof item.index !== "number") {
			return null;
		}
		refs.push({ side: item.side, index: item.index });
	}
	return refs;
}

/**
 * AIアライン応答をバリデートする。
 * 判別は以下の優先順位:
 *   1. corrections フィールド（配列）があれば corrections
 *   2. needBodies フィールド（配列）があれば needBodies
 *   3. ok===true / 空オブジェクトなら ok
 * いずれの配列も型不正ならリトライ可能エラーを返す。
 */
export function validateAlignResponse(rawResponse: string): ValidationResult<ParsedAlignResponse> {
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

	if ("corrections" in parsed && parsed.corrections !== undefined && parsed.corrections !== null) {
		const corrections = parseCorrections(parsed.corrections);
		if (!corrections) {
			return {
				valid: false,
				error: {
					code: "INVALID_FIELD_TYPE",
					message: "'corrections' must be an array of {sourceIndex, targetIndex, confidence}",
					retryable: true,
				},
			};
		}
		return { valid: true, parsed: { kind: "corrections", corrections } };
	}

	if ("needBodies" in parsed && parsed.needBodies !== undefined && parsed.needBodies !== null) {
		const refs = parseNeedBodies(parsed.needBodies);
		if (!refs) {
			return {
				valid: false,
				error: {
					code: "INVALID_FIELD_TYPE",
					message: "'needBodies' must be an array of {side, index}",
					retryable: true,
				},
			};
		}
		return { valid: true, parsed: { kind: "needBodies", refs } };
	}

	// corrections も needBodies も無い場合、ok は ok===true または空オブジェクトに限定する。
	// {"ok": false} や {"error": ...} 等は no-op で握り潰さず、不正応答としてリトライさせる。
	if (parsed.ok === true || Object.keys(parsed).length === 0) {
		return { valid: true, parsed: { kind: "ok" } };
	}
	return {
		valid: false,
		error: {
			code: "INVALID_FIELD_TYPE",
			message: 'Response must be one of {"ok": true} | {"corrections": [...]} | {"needBodies": [...]}',
			retryable: true,
		},
	};
}
