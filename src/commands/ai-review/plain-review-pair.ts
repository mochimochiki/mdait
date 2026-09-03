/**
 * @file plain-review-pair.ts
 * @description
 *   非Markdown（`trans.extensions` で管理するファイル）のレビュー対象ペアを組み立てる。
 *
 *   非Markdownは**ファイル1本が1ユニット**で、マーカーを本文に埋め込めないため状態は
 *   `unit-state` の行にしか無い（`file-type.ts`）。そのため Markdown のように本文を
 *   パースしてユニットを取り出すことができない。ここで行からユニットを組み立て直し、
 *   **あとの流れは Markdown とまったく同じもの**（`collectReviewPairs` → 検証 → 判定の適用）
 *   に載せる。ペアさえ同じ形なら、検証も判定もファイルの種類を知る必要がない。
 *
 *   VS Code API 非依存（`pair-collector` と同じ）。
 * @module commands/ai-review/plain-review-pair
 */

import { MdaitMarker } from "../../core/markdown/mdait-marker";
import { MdaitUnit } from "../../core/markdown/mdait-unit";
import type { UnitStateEntry } from "../../core/unit-state/unit-state-store";
import { type ReviewCollectMode, type ReviewPair, collectReviewPairs } from "./pair-collector";

/** ペアの組み立てに要る行の項目だけ */
export type PlainReviewEntry = Pick<UnitStateEntry, "hash" | "from" | "need">;

/**
 * 非Markdownファイルのレビュー対象ペアを組み立てる。
 *
 * 対象になる条件は Markdown と同じ（`collectReviewPairs` に委ねる）。`from` が無い行は
 * 比べる相手が決まらないので対象にならない — そこは判断を分けず、同じ関数に決めさせる。
 *
 * @param entry `unit-state` の行（訳文ファイルの order 0）。無ければ対象なし
 * @param sourceContent 原文ファイルの中身（まるごと1ユニット）
 * @param targetContent 訳文ファイルの中身（まるごと1ユニット）
 * @param title レポートで指す名前。ファイル名を渡す（非Markdownに見出しは無い）
 * @param mode 既定の "pending"（need:review のみ）か "audit"（確定済みも見る）
 * @returns 対象なら1件、そうでなければ `undefined`
 */
export function buildPlainReviewPair(
	entry: PlainReviewEntry | undefined,
	sourceContent: string,
	targetContent: string,
	title: string,
	mode: ReviewCollectMode = "pending",
): ReviewPair | undefined {
	if (!entry) {
		return undefined;
	}
	// 見出しレベル 0 は「非MD・先頭本文ユニット」を表す（`UnitStateEntry.level` の約束）
	const targetUnit = new MdaitUnit(
		new MdaitMarker(entry.hash, entry.from || null, entry.need || null),
		title,
		0,
		targetContent,
	);
	// 原文側は from で引かれる相手なので、hash が from と一致していればよい
	const sourceUnit = new MdaitUnit(new MdaitMarker(entry.from), title, 0, sourceContent);
	return collectReviewPairs([sourceUnit], [targetUnit], mode)[0];
}
