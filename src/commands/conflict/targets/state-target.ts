/**
 * @file state-target.ts
 * @description
 *   `unit-state` と `unit-registry` の競合を解く（roadmap-v04 P02）。
 *
 *   **この2つには選択が要らない。** 読み取りがもともと競合マーカーを読み飛ばし、読めた行を
 *   1行残らず拾う作りになっているからである（ADR-260906-02・ADR-260906-03）。
 *
 *   - `unit-state` … 同じ席に2行来たら、片方を席から降ろして**どちらも残す**。降ろされた
 *     行には「押し出された元の席」が残る（ADR-260911-03）ので、あとから人が拾える。
 *     どちらを席に残すかは値の順で決まり、読んだ順には依らない
 *   - `unit-registry` … 控えの鍵は本文そのもののハッシュなので、**同じ鍵に別の値が来ない**。
 *     両方残せば解ける（ADR-260911-02）
 *
 *   だからやることは「読み直して、正規形で書き戻す」だけで、その結果ファイルから
 *   競合マーカーが消える。
 *
 *   残るのは、降ろされた行をどちらに決めるかである。それは訳の良し悪しではなく**原稿との
 *   照合**なので、P03 が決定的に片付ける。
 *
 * @module commands/conflict/targets/state-target
 */
import { UnitRegistryManager } from "../../../core/unit-registry/unit-registry-manager";
import { UnitStateStore } from "../../../core/unit-state/unit-state-store";
import { withUnitStateLock } from "../../../infra/workspace/unit-state-lock";
import type { ResolutionPlan } from "../resolution-plan";

/**
 * `unit-state` の競合の計画を作る。**判断を求める件は1つも無い。**
 *
 * 件数はここでは数えない。数えるには読み直すしかなく、読み直しはストア全体を捨てて
 * 入れ替える操作なので、**ロックの外でやってはいけない**（読み込み途中の表を別の処理が
 * 永続化しうる）。実際に解いた件数は書き戻したあとに返る。
 */
export function planUnitStateResolution(filePath: string): ResolutionPlan {
	return {
		kind: "unit-state",
		filePath,
		autoResolvedCount: 0,
		deletedCount: 0,
		pending: [],
		wholeFile: true,
	};
}

/** 解いた結果 */
export interface StateResolutionOutcome {
	/** 書き戻した行の数 */
	rows: number;
	/** 同じ席に2行来たので片方を席から降ろした回数（P03 が片付ける） */
	unseated: number;
}

/**
 * `unit-state` を読み直して正規形で書き戻す。読めた行はすべて残る。
 *
 * **ストア全体の排他を取る。** `load()` は表を丸ごと捨ててディスクから読み直すので、
 * ロックの外でやると sync や一括変換の書き換えが無言で消える。ファイル単位の排他は
 * 使わないので、順序（ストア → ファイル）の制約にも触れない。
 */
export async function applyUnitStateResolution(mdaitDir: string): Promise<StateResolutionOutcome> {
	return withUnitStateLock(async () => {
		const store = UnitStateStore.getInstance();
		// 合流はこの外で起きているので、メモリの上の版は合流の前の姿である。読み直す
		store.load(mdaitDir);
		const report = store.getLastParseReport();
		store.save(mdaitDir);
		return { rows: store.getAllEntries().length, unseated: report.duplicates };
	});
}

/**
 * 台帳の競合の計画を作る。**判断を求める件は1つも無い。**
 */
export function planUnitRegistryResolution(filePath: string): ResolutionPlan {
	return {
		kind: "unit-registry",
		filePath,
		// 件数は読み直してみないと分からない。書き戻したあとに数える
		autoResolvedCount: 0,
		deletedCount: 0,
		pending: [],
		wholeFile: true,
	};
}

/**
 * 台帳を正規形で書き戻す。読めた控えはすべて残る。
 *
 * **`unit-state` と同じ排他の内側で行う。** 台帳の読み書き（`flushBuffer`）は sync の
 * ストア全体の排他の中で起きるので、ここだけ外で読み直すと、sync が抱えている控えと
 * 読み直した結果が互いを上書きしうる。
 */
export async function applyUnitRegistryResolution(): Promise<number> {
	return withUnitStateLock(async () => UnitRegistryManager.getInstance().resolveConflict());
}
