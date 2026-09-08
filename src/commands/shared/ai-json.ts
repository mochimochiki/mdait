/**
 * @file ai-json.ts
 * @description
 *   **AI の答えから JSON を読む、1つの入口。**
 *
 *   AI へ JSON を頼む経路（用語を拾う・訳語を埋める）は、答えを読めなかったときに
 *   `UnusableAIResponseError` を投げる。0件として飲み込むと「見つからなかった」と
 *   区別が付かなくなるためである（ADR-260908-03）。
 *
 *   ただし**読み方が厳しすぎても同じ害になる。** 読めるはずの答えを「使えない」と
 *   突き返すと、今度は動くはずの仕事が止まる。だからここでは順に3つ試す。
 *     1. コードフェンスの中（`extractJsonFromResponse`。前置き・後書きはここで落ちる）
 *     2. 全文そのまま
 *     3. 最初の `[` / `{` から、同じ種類の最後の閉じ括弧まで（前後に説明文が付いた形）
 *
 *   3 で**最後の**閉じ括弧まで取るのは意図してのこと。用語の答えは
 *   `[{"variants":["…"]}]` のように配列が入れ子になるので、最初の `]` で切ると必ず壊れる。
 *
 * @module commands/shared/ai-json
 */
import { UnusableAIResponseError } from "../../infra/llm/unusable-response";
import { extractJsonFromResponse } from "../trans/response-validator";

/**
 * AI の答えを JSON として読む。読めなければ「使えない答え」として断ち切る。
 *
 * @param response AI からの生の答え
 * @param what 記録用の呼び名（英語。例: "Term detection"）
 * @throws {UnusableAIResponseError} 本文が空（`empty`）／JSON として読めない（`invalid-format`）
 */
export function parseJsonAnswer(response: string, what: string): unknown {
	const trimmed = (response ?? "").trim();
	if (trimmed.length === 0) {
		throw new UnusableAIResponseError("empty", `${what} response was empty`, "responseChars=0");
	}

	const unfenced = extractJsonFromResponse(trimmed);
	for (const candidate of [unfenced, sliceOutermost(unfenced)]) {
		if (!candidate) continue;
		try {
			return JSON.parse(candidate);
		} catch {
			// 次の読み方を試す
		}
	}

	throw new UnusableAIResponseError(
		"invalid-format",
		`${what} response could not be read as JSON`,
		`responseChars=${trimmed.length}`,
	);
}

/**
 * 最初の `[` か `{` から、同じ種類の最後の閉じ括弧までを切り出す。
 * 前後に説明文が付いた答えのための最後の手段。見つからなければ空文字。
 */
function sliceOutermost(text: string): string {
	const firstArray = text.indexOf("[");
	const firstObject = text.indexOf("{");
	const opensWithArray = firstArray >= 0 && (firstObject < 0 || firstArray < firstObject);
	const start = opensWithArray ? firstArray : firstObject;
	if (start < 0) return "";
	const end = text.lastIndexOf(opensWithArray ? "]" : "}");
	return end > start ? text.slice(start, end + 1) : "";
}
