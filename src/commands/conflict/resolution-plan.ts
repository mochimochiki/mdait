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

/**
 * 消した側の値の代わりに置く目印。
 *
 * **訳さない。** この文字列は AI へ送る文面にもそのまま載るので、表示の言語で揺れては
 * 困る。人に見せるときは、この目印ではなく印（`oursDeleted` / `theirsDeleted`）を見て
 * その場の言葉で書く。
 */
export const REMOVED_TEXT = "(removed)";

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
	/**
	 * **自分の側はこの件を消していた。** 採るとは「消したままにする」ことで、
	 * `oursText` に見えている祖先の値を書き戻すことではない。
	 */
	oursDeleted?: boolean;
	/** **相手の側はこの件を消していた。** 意味は `oursDeleted` と同じ */
	theirsDeleted?: boolean;
}

/**
 * その件が「片方が消し、片方が直した」形か。
 *
 * **この形は AI へ送らない。** AI に許した語彙は「既にある2つの値のどちらかを選ぶ」だけで
 * （ADR-260912-01）、消すことはその外にある。人が決める（P03）。
 */
export function isDeletionChoice(item: PendingChoice): boolean {
	return item.oursDeleted === true || item.theirsDeleted === true;
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
	/** 判定で決まって書き戻した件数 */
	decidedCount: number;
	/** 決まらずに残した件数（AI が迷った・API キーが無い） */
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
	/** そのうち AI へ問い合わせられる件数（消した件は AI へ送らない） */
	aiTotal: number;
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
		aiTotal: plans.reduce((sum, plan) => sum + plan.pending.filter((item) => !isDeletionChoice(item)).length, 0),
		wholeFileCount: plans.filter((plan) => plan.wholeFile === true).length,
		failures: [...failures],
		heldRowCount,
	};
}
