/**
 * @file resolution-plan.ts
 * @description
 *   競合の解決の「計画」— **何が決定的に決まり、何が人の判断を待っているか**（roadmap-v04）。
 *
 *   計画を作る段では**1バイトも書かない**。確認ダイアログはこの計画から件数を出すので、
 *   承認の前に「何件が決まり、何件が残り、どこへ書くか」が言える。
 *
 *   人の前に出るのは `pending` だけである。`autoResolved` は鍵の突き合わせで決まった分で、
 *   誰も通らない（`core/conflict/key-merge.ts`）。
 *
 * @module commands/conflict/resolution-plan
 */
import type { ConflictFileKind } from "../../core/conflict/mdait-conflicts";

/** 人の判断を待っている1件 */
export interface PendingChoice {
	/** 対象の中で1件を指す鍵（語・tuid・席） */
	key: string;
	/** 人が読む見出し（語そのもの、原文の先頭、ファイル名と席） */
	label: string;
	/** 自分の側の値を人が読める形にしたもの。**消した側は空**（`oursDeleted` を見る） */
	oursText: string;
	/** 相手の側の値を人が読める形にしたもの。**消した側は空**（`theirsDeleted` を見る） */
	theirsText: string;
	/** 共通の祖先（diff3 形式で取れたときだけ） */
	baseText?: string;
	/**
	 * **自分の側はこの件を消していた。** 採るとは「消したままにする」ことで、
	 * `oursText` に見えている祖先の値を書き戻すことではない。
	 */
	oursDeleted?: boolean;
	/** **相手の側はこの件を消していた。** 意味は `oursDeleted` と同じ */
	theirsDeleted?: boolean;
}

/** どちらを採るか。**新しい値は作らない**（ADR-260911-02: 採否は人の宣言に留める） */
export type ChoiceSide = "ours" | "theirs";

/** 1つの対象についての計画 */
export interface ResolutionPlan {
	kind: ConflictFileKind;
	/** 対象のファイル（絶対パス） */
	filePath: string;
	/** 鍵の突き合わせで決まった件数（誰も通らない） */
	autoResolvedCount: number;
	/** 祖先を見て「片方が消した」と判断して落とした件数 */
	deletedCount: number;
	/** 人の判断を待っている件 */
	pending: PendingChoice[];
	/**
	 * **1件ずつ選ぶのではなく、ファイルを丸ごと書き直す対象か**（`unit-state` と `unit-registry`）。
	 *
	 * この2つは選択が要らないので `pending` も `autoResolvedCount` も 0 のまま計画に載る。
	 * 件数だけで確認ダイアログを組むと「0件を解決しますか」と聞くことになるので、
	 * 「丸ごと書き直すファイルが何個あるか」をここから数える。
	 */
	wholeFile?: boolean;
	/**
	 * `unit-state` で、同じ席に2行来たので片方を席から降ろした回数。
	 *
	 * 降ろされた行はどちらも残るので**ここでは決まらなくてよい**が、原稿との照合で
	 * 決めるべき件がこれだけ増えたことは人に伝わったほうがよい（P03 が片付ける）。
	 */
	unseatedCount?: number;
}

/** 計画を実行した結果 */
export interface ResolutionOutcome {
	kind: ConflictFileKind;
	filePath: string;
	/** 決定的に決まって書き戻した件数 */
	autoResolvedCount: number;
	/** まだ人が決めていない件数 */
	remainingCount: number;
	/** 書き戻したか（迷った件があれば1バイトも書かない対象もある） */
	written: boolean;
	/**
	 * `unit-state` で、同じ席に2行来たので片方を席から降ろした件数。
	 *
	 * **解けていないのではない** — 行はどちらも残っている。原稿と突き合わせて
	 * どちらを席へ戻すかを決めるのが P03 の仕事で、その件数をここで伝える。
	 */
	unseatedCount?: number;
	/** 失敗した理由（あれば） */
	error?: string;
	/** 取り消されて、手が付かなかったか（`remainingCount` は計画のままの件数になる） */
	skipped?: boolean;
}

/** 競合しているのに計画すら作れなかった対象（壊れている・読めない） */
export interface ResolutionFailure {
	kind: ConflictFileKind;
	filePath: string;
	/** 読めなかった理由 */
	error: string;
}

/**
 * 計画の全体。確認ダイアログはここから件数を出す。
 */
export interface ConflictResolutionPlan {
	plans: ResolutionPlan[];
	/** 鍵の突き合わせで決まる総数 */
	autoResolvedTotal: number;
	/** 人の判断を待つ総数 */
	pendingTotal: number;
	/** ファイルを丸ごと書き直す対象の数（1件ずつの選択が無いので件数に出ない） */
	wholeFileCount: number;
	/** 競合しているのに読めなかった対象。**「競合が無い」と混ぜない** */
	failures: ResolutionFailure[];
	/** 合流で席から降ろされた `unit-state` の行の数（解決ではなく同期が片付ける） */
	heldRowCount: number;
}

/** 計画をまとめる */
export function summarizePlans(
	plans: readonly ResolutionPlan[],
	failures: readonly ResolutionFailure[] = [],
	heldRowCount = 0,
): ConflictResolutionPlan {
	return {
		plans: [...plans],
		autoResolvedTotal: plans.reduce((sum, plan) => sum + plan.autoResolvedCount, 0),
		pendingTotal: plans.reduce((sum, plan) => sum + plan.pending.length, 0),
		wholeFileCount: plans.filter((plan) => plan.wholeFile === true).length,
		failures: [...failures],
		heldRowCount,
	};
}
