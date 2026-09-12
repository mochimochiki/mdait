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
 *   だからここは AI を1回も呼ばない。やることは「読み直して、正規形で書き戻す」だけで、
 *   その結果ファイルから競合マーカーが消える。
 *
 *   残るのは、降ろされた行をどちらに決めるかである。それは訳の良し悪しではなく**原稿との
 *   照合**なので、P03 が決定的に片付ける。
 *
 * @module commands/conflict/targets/state-target
 */
import { UnitRegistryManager } from "../../../core/unit-registry/unit-registry-manager";
import { UnitStateStore } from "../../../core/unit-state/unit-state-store";
import type { ResolutionPlan } from "../resolution-plan";

/**
 * `unit-state` の競合の計画を作る。**判断を求める件は1つも無い。**
 *
 * @param mdaitDir `.mdait` の絶対パス
 * @param filePath `unit-state` の絶対パス
 */
export function planUnitStateResolution(mdaitDir: string, filePath: string): ResolutionPlan {
	const store = UnitStateStore.getInstance();
	// 合流はこの外で起きているので、メモリの上の版は合流の前の姿である。読み直す
	store.load(mdaitDir);
	const report = store.getLastParseReport();
	return {
		kind: "unit-state",
		filePath,
		// 競合マーカーを読み飛ばして拾った行が、そのまま「決定的に決まった分」である
		autoResolvedCount: store.getAllEntries().length,
		deletedKeys: [],
		pending: [],
		hasBase: false,
		// 席を分けた回数は、P03 が片付ける「降ろされた行」の数でもある
		unseatedCount: report.duplicates,
	};
}

/**
 * `unit-state` を正規形で書き戻す。読めた行はすべて残る。
 *
 * 書き出しは `UnitStateStore.save` を通る — 原子的な書き込みと、傷のあった回の原本の
 * 避難はそこにしか無い。
 */
export function applyUnitStateResolution(mdaitDir: string): number {
	const store = UnitStateStore.getInstance();
	store.save(mdaitDir);
	return store.getAllEntries().length;
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
		deletedKeys: [],
		pending: [],
		hasBase: false,
	};
}

/** 台帳を正規形で書き戻す。読めた控えはすべて残る */
export async function applyUnitRegistryResolution(): Promise<number> {
	return UnitRegistryManager.getInstance().resolveConflict();
}
