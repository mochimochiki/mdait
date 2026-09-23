/**
 * @file ai-json.ts
 * @description
 *   **用語を拾う・訳語を埋める経路が、AI の答えから JSON を読むときの入口。**
 *
 *   この2つの経路は、答えを読めなかったときに `UnusableAIResponseError` を投げる。
 *   0件として飲み込むと「見つからなかった」と区別が付かなくなるためである（ADR-260908-03）。
 *   翻訳・TM 登録・AI レビュー・取り込みの経路は、いまも `extractJsonFromResponse` を
 *   直に使っており、ここは通らない。
 *
 *   ただし**読み方が厳しすぎても同じ害になる。** 読めるはずの答えを「使えない」と
 *   突き返すと、今度は動くはずの仕事が止まる。だからここでは順に2つ試す。
 *     1. `extractJsonFromResponse` の結果。コードフェンスがあればその中身（前置き・後書きは
 *        ここで落ちる）、無ければ全文
 *     2. 1 の中の、最初の `[` / `{` から同じ種類の最後の閉じ括弧まで（前後に説明文が付いた形）
 *
 *   2 で**最後の**閉じ括弧まで取るのは意図してのこと。用語の答えは
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

/**
 * JSON としては読めたが、形が合わない答えを表す例外を作る。
 * message は記録用の英語。利用者向けの文は呼び出し側が理由（`invalid-format`）から組む。
 *
 * @param what 記録用の呼び名（`parseJsonAnswer` に渡したものと同じ。例: "Term detection"）
 * @param response AI からの生の答え
 * @param why 何が合わなかったか（記録用の英語）
 */
export function unusableJsonAnswer(what: string, response: string, why: string): UnusableAIResponseError {
	return new UnusableAIResponseError(
		"invalid-format",
		`${what} response was not usable: ${why}`,
		`responseChars=${response.length}`,
	);
}
