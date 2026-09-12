/**
 * @file conflict-response-validator.ts
 * @description
 *   競合の判定の応答を検証する（roadmap-v04 P02）。
 *
 *   **語彙は二択と「決められない」の3つだけ**である（ADR-260911-02 / 2026-09-12 の決定）。
 *   AI は既にある2つの値のどちらかを選ぶか、選べないと言うことしかできない — **新しい訳文や
 *   訳語は書けない**。採否は人の宣言に留めるという線（`need` の解除と同じ理屈）を、
 *   AI にも同じく引く。両方を合わせる形は、鍵の突き合わせで**決定的に決まるときだけ**
 *   行う（`core/conflict/key-merge.ts`）。
 *
 *   知らない件・番号の合わない件・語彙の外の値は**捨てる**。捨てた件は「決まらなかった」
 *   として残り、人が決める（P03）。黙って片方を採るより、残すほうが安全である。
 *
 * @module commands/conflict/conflict-response-validator
 */
import type { ChoiceSide } from "./resolution-plan";

/** 判定1件（検証を通ったもの） */
export interface ConflictDecision {
	/** 送った件の番号（1始まり） */
	index: number;
	side: ChoiceSide;
	/** なぜそちらを採るのか（1行） */
	reason: string;
}

/** 検証の結果 */
export interface ConflictResponseValidation {
	decisions: ConflictDecision[];
	/** 捨てた件の理由（ログとレポートに出す。人には件数だけ見せる） */
	discarded: string[];
	/**
	 * 応答が**まるごと読めなかった**か。
	 *
	 * 「読めたが1件も決まらなかった」（`{"decisions":[]}`）と区別する。前者は問い直す
	 * 値打ちがあるが、後者は AI が答えた結果なので問い直しても同じ答えが返るだけである。
	 */
	unreadable: boolean;
}

/**
 * 文字列の中で、`start` の `{` と対になる `}` の位置を返す（無ければ -1）。
 *
 * 文字列リテラルの中の括弧とエスケープは数えない。
 */
function matchingBrace(body: string, start: number): number {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < body.length; i++) {
		const ch = body[i];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (ch === "\\") {
				escaped = true;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
		} else if (ch === "{") {
			depth++;
		} else if (ch === "}") {
			depth--;
			if (depth === 0) {
				return i;
			}
		}
	}
	return -1;
}

/**
 * 応答から JSON の本体を取り出す（コードフェンスに包まれていても読む）。
 *
 * **前後の説明文に別の `{...}` が混ざっていても読めるようにする。** 最初の `{` から
 * 最後の `}` までを丸ごと切り出す形だと、`ここが私の考えです {補足} 次が答えです
 * {"decisions":[...]}` のような応答でまるごと読めなくなり、問い直しを1回無駄にしていた。
 * 括弧を対応付けて、`decisions` を持つ最初のまとまりを返す。
 */
function extractJson(raw: string): string {
	const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
	const body = (fenced ? fenced[1] : raw).trim();
	let fallback: string | undefined;
	for (let start = body.indexOf("{"); start >= 0; start = body.indexOf("{", start + 1)) {
		const end = matchingBrace(body, start);
		if (end < 0) {
			break;
		}
		const candidate = body.slice(start, end + 1);
		try {
			const parsed = JSON.parse(candidate) as { decisions?: unknown };
			if (Array.isArray(parsed?.decisions)) {
				return candidate;
			}
			fallback ??= candidate;
		} catch {
			// このまとまりは JSON として読めない。次の `{` を試す
		}
	}
	return fallback ?? body;
}

/**
 * 判定の応答を検証する。
 *
 * @param raw AI の応答（そのまま）
 * @param expectedCount 送った件数（番号の範囲の検証に使う）
 */
export function validateConflictResponse(raw: string, expectedCount: number): ConflictResponseValidation {
	const discarded: string[] = [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(extractJson(raw));
	} catch {
		return { decisions: [], discarded: ["The response was not valid JSON."], unreadable: true };
	}

	const list = (parsed as { decisions?: unknown })?.decisions;
	if (!Array.isArray(list)) {
		return { decisions: [], discarded: ["The response had no decisions array."], unreadable: true };
	}

	// **同じ番号に2つの答えが来たら、その番号はまるごと決まらなかったことにする。**
	// 先に来たほうを残すと、どちらが正しいか分からないものを黙って採ることになる
	const counts = new Map<number, number>();
	for (const item of list) {
		const index = (item as Record<string, unknown>)?.index;
		if (typeof index === "number") {
			counts.set(index, (counts.get(index) ?? 0) + 1);
		}
	}

	const decisions: ConflictDecision[] = [];
	const seen = new Set<number>();
	for (const item of list) {
		const record = item as Record<string, unknown>;
		const index = typeof record?.index === "number" ? record.index : Number.NaN;
		if (!Number.isInteger(index) || index < 1 || index > expectedCount) {
			discarded.push(`index ${String(record?.index)} is outside 1..${expectedCount}`);
			continue;
		}
		if ((counts.get(index) ?? 0) > 1) {
			// 同じ件に2つの答えが来た。**どちらも採らない**
			if (!seen.has(index)) {
				discarded.push(`index ${index} was answered more than once`);
			}
			seen.add(index);
			continue;
		}
		seen.add(index);

		const side = record?.side;
		if (side === "unsure") {
			discarded.push(`index ${index} was answered "unsure"`);
			continue;
		}
		if (side !== "ours" && side !== "theirs") {
			discarded.push(`index ${index} had an unknown side: ${String(side)}`);
			continue;
		}
		const reason = typeof record?.reason === "string" ? record.reason.trim() : "";
		decisions.push({ index, side, reason });
	}

	return { decisions, discarded, unreadable: false };
}
