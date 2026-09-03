/**
 * @file unusable-response.ts
 * @description
 *   「AI は答えたが、その答えは使えない」ことを表す例外。
 *
 *   AI へ届かない（ネットワーク断・401・500）失敗とは別物である。届いてはいるので
 *   送り直しても直らないことが多く、一方で**中身を採用してはいけない**。
 *   以前はここが型として存在せず、翻訳だけが「検証に落ちた生応答をそのまま訳文にする」
 *   後始末を持っていた。結果、途中で切れた JSON や空文字がそのまま本文になり、
 *   need フラグまで外れて「翻訳できた」と報告されていた。
 *
 *   用語検出・用語展開・TM 登録は同じ意地悪を件数0で跳ね返している。この例外は、
 *   翻訳系をその基準へ合流させるための共通語彙である。
 *
 * @module infra/llm/unusable-response
 */

/** 答えが使えない理由 */
export type UnusableResponseReason =
	/** 出力上限に当たって途中で切れた（finish_reason: "length"） */
	| "truncated"
	/** 本文が空だった */
	| "empty"
	/** 期待している形（JSON のスキーマ）から外れていた */
	| "invalid-format";

/**
 * AI の答えが使えないことを表す例外。
 *
 * **message は記録用**（英語・原因の要約）。利用者へ見せる文は `reason` から
 * 呼び出し側が組み立てる（l10n を通すため。`commands/shared/guidance.ts`）。
 * 生の応答そのものは持たせない — 持たせると、うっかり本文へ流用する道が復活する。
 */
export class UnusableAIResponseError extends Error {
	/** 使えない理由 */
	readonly reason: UnusableResponseReason;
	/** 記録用の補足（何回試したか・検証エラーの種類など） */
	readonly detail: string;

	constructor(reason: UnusableResponseReason, message: string, detail = "") {
		super(message);
		this.name = "UnusableAIResponseError";
		this.reason = reason;
		this.detail = detail;
	}
}

/** 「答えが使えない」失敗か */
export function isUnusableAIResponse(error: unknown): error is UnusableAIResponseError {
	return error instanceof UnusableAIResponseError;
}
