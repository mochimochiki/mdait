/**
 * @file resolution-plan.ts
 * @description
 *   競合の解決の「計画」— **何が決定的に決まり、何が人の判断を待っているか**（roadmap-v04 P02）。
 *
 *   計画を作る段では**1バイトも書かない**。確認ダイアログはこの計画から件数と概算を出すので、
 *   AI へ問い合わせる前に「何件を、いくらで、どこへ書くか」が言える（UX-P4）。
 *
 *   判定にかけるのは `undecided` だけである。`autoResolved` は鍵の突き合わせで決まった分で、
 *   AI も人も通らない（`core/conflict/key-merge.ts`）。
 *
 * @module commands/conflict/resolution-plan
 */
import type { ConflictFileKind } from "../../core/conflict/mdait-conflicts";

/** 人の判断を待っている1件。AI にも人にも、この形のまま見せる */
export interface PendingChoice {
	/** 対象の中で1件を指す鍵（語・tuid・席） */
	key: string;
	/** 人が読む見出し（語そのもの、原文の先頭、ファイル名と席） */
	label: string;
	/** 自分の側の値を人が読める形にしたもの */
	oursText: string;
	/** 相手の側の値を人が読める形にしたもの */
	theirsText: string;
	/** 共通の祖先（diff3 形式で取れたときだけ） */
	baseText?: string;
}

/** どちらを採るか。**新しい値は作らない**（ADR-260911-02: 採否は人の宣言に留める） */
export type ChoiceSide = "ours" | "theirs";

/** 1件の判定 */
export interface Verdict {
	key: string;
	side: ChoiceSide;
	/** なぜそちらを採るのか（1行）。レポートと Hover に出す */
	reason: string;
}

/** 1つの対象についての計画 */
export interface ResolutionPlan {
	kind: ConflictFileKind;
	/** 対象のファイル（絶対パス） */
	filePath: string;
	/** 鍵の突き合わせで決まった件数（AI も人も通らない） */
	autoResolvedCount: number;
	/** 祖先を見て「片方が消した」と判断して落とした鍵 */
	deletedKeys: string[];
	/** 人の判断を待っている件 */
	pending: PendingChoice[];
	/** 共通の祖先が取れたか（取れないと判定の材料が1つ減る） */
	hasBase: boolean;
}

/** 計画を実行した結果 */
export interface ResolutionOutcome {
	kind: ConflictFileKind;
	filePath: string;
	/** 決定的に決まって書き戻した件数 */
	autoResolvedCount: number;
	/** 判定で決まって書き戻した件数 */
	decidedCount: number;
	/** 決まらずに残した件数（AI が迷った・API キーが無い） */
	remainingCount: number;
	/** 書き戻したか（迷った件があれば1バイトも書かない対象もある） */
	written: boolean;
	/** 失敗した理由（あれば） */
	error?: string;
}

/**
 * 計画の全体。確認ダイアログはここから件数を出す。
 */
export interface ConflictResolutionPlan {
	plans: ResolutionPlan[];
	/** 鍵の突き合わせで決まる総数 */
	autoResolvedTotal: number;
	/** 判定にかける総数（＝AI へ問い合わせる件数） */
	pendingTotal: number;
}

/** 計画をまとめる */
export function summarizePlans(plans: readonly ResolutionPlan[]): ConflictResolutionPlan {
	return {
		plans: [...plans],
		autoResolvedTotal: plans.reduce((sum, plan) => sum + plan.autoResolvedCount, 0),
		pendingTotal: plans.reduce((sum, plan) => sum + plan.pending.length, 0),
	};
}
