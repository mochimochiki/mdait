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
}

/** 応答から JSON の本体を取り出す（コードフェンスに包まれていても読む） */
function extractJson(raw: string): string {
	const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
	const body = (fenced ? fenced[1] : raw).trim();
	const start = body.indexOf("{");
	const end = body.lastIndexOf("}");
	return start >= 0 && end > start ? body.slice(start, end + 1) : body;
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
		return { decisions: [], discarded: ["The response was not valid JSON."] };
	}

	const list = (parsed as { decisions?: unknown })?.decisions;
	if (!Array.isArray(list)) {
		return { decisions: [], discarded: ["The response had no decisions array."] };
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
		if (seen.has(index)) {
			// 同じ件に2つの答えが来た。**後から来たほうを採らない** — どちらが正しいか
			// 分からないものを黙って採るより、決まらなかったことにするほうが安全である
			discarded.push(`index ${index} was answered twice`);
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

	return { decisions, discarded };
}
