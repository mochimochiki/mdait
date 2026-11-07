/**
 * @file keyed-target.ts
 * @description
 *   鍵で突き合わせて解く対象（翻訳メモリと用語集）に共通の段取り。
 *
 *   2つの対象で違うのは**読み方と書き方と見せ方**だけで、「両側を切り出す → 鍵で突き合わせる →
 *   人が決めた分を足して最終形を作る」は同じである。ここはその同じ部分を持つ。
 *
 * @module commands/conflict/targets/keyed-target
 */
import { splitConflictedFile } from "../../../core/conflict/conflict-sections";
import { type KeyMergeOptions, type UndecidedEntry, mergeByKey } from "../../../core/conflict/key-merge";
import { mineSideOf } from "../../../core/conflict/conflict-orientation";
import { hasConflictMarkersInDataFile } from "../../../core/markdown/conflict-markers";
import type { ChoiceSide, PendingChoice, ResolutionPlan } from "../resolution-plan";

/** 両側と共通の祖先を、鍵で引ける表にしたもの */
export interface KeyedSides<T> {
	ours: Map<string, T>;
	theirs: Map<string, T>;
	base?: Map<string, T>;
}

/** 解いた結果を組み立てるための持ち物（計画と一緒に持ち回る） */
export interface KeyedResolution<T> {
	sides: KeyedSides<T>;
	/** 決定的に決まった分 */
	resolved: Map<string, T>;
}

/** 切り出した3つの全文（祖先は diff3 形式のときだけ）と、自分の側 */
export interface SplitTexts {
	ours: string;
	theirs: string;
	base?: string;
	mineSide: ChoiceSide;
}

/**
 * 競合マーカーの入ったファイルを両側に切り出す。
 *
 * @returns 競合していなければ `undefined`
 * @throws マーカーはあるのに競合ブロックとして読めないとき（`<<<<<<<` の行だけ消した、など）。
 *   ここで `undefined` を返すと「競合は無い」と扱われ、ツリーには競合として出続けるのに
 *   解く手立ても理由も見えなくなる。投げれば「読めなかったファイル」として報告される
 */
export function splitForResolution(filePath: string, content: string): SplitTexts | undefined {
	const split = splitConflictedFile(content);
	if (split.conflicted) {
		return { ours: split.ours, theirs: split.theirs, base: split.base, mineSide: mineSideOf(filePath, content) };
	}
	if (hasConflictMarkersInDataFile(content)) {
		throw new Error("The conflict markers are incomplete (no line starting with <<<<<<<). Fix them by hand.");
	}
	return undefined;
}

/** 計画を作るための、対象ごとの違い */
export interface KeyedPlanOptions<T> extends KeyMergeOptions<T> {
	/** 1件を人が読める1行にする（見出しに出るものは繰り返さない） */
	describe(entry: T): string;
	/** 決まらなかった1件の見出し */
	labelOf(item: UndecidedEntry<T>): string;
}

/**
 * 鍵で突き合わせ、決定的に決まるものと決まらないものに分ける。**1バイトも書かない。**
 */
export function planKeyedResolution<T>(
	kind: ResolutionPlan["kind"],
	filePath: string,
	mineSide: ChoiceSide,
	sides: KeyedSides<T>,
	options: KeyedPlanOptions<T>,
): { plan: ResolutionPlan; resolution: KeyedResolution<T> } {
	const toEntries = (map: Map<string, T>) => [...map].map(([key, value]) => ({ key, value }));
	const merged = mergeByKey(
		toEntries(sides.ours),
		toEntries(sides.theirs),
		sides.base ? toEntries(sides.base) : undefined,
		options,
	);

	const pending: PendingChoice[] = merged.undecided.map((item) => ({
		key: item.key,
		label: options.labelOf(item),
		// 消した側には見せる値が無い。祖先の値を置かず**空にする** — 値を出すと、
		// その側を採れば値が戻ると読めてしまう。出す言葉は表示する側が決める
		oursText: item.oursDeleted ? "" : options.describe(item.ours),
		theirsText: item.theirsDeleted ? "" : options.describe(item.theirs),
		baseText: item.base ? options.describe(item.base) : undefined,
		oursDeleted: item.oursDeleted,
		theirsDeleted: item.theirsDeleted,
	}));

	return {
		plan: {
			kind,
			filePath,
			// 両側で同じだった件は数えない。競合ブロックの外の件もすべてそこに入るので、
			// 数えると「1万件を自動で片付けた」と言うことになる
			autoResolvedCount: merged.resolved.length - merged.sameCount,
			deletedCount: merged.deleted.length,
			pending,
			mineSide,
		},
		resolution: { sides, resolved: new Map(merged.resolved.map((r) => [r.key, r.value])) },
	};
}

/**
 * 人が決めた分を足して、書き戻す最終形を作る。
 *
 * @returns 決まらない件が1つでも残っていれば `undefined`（その対象は1バイトも書かない。
 *   半端に書き戻すと、残った件の両側がディスクから消える）
 */
export function finalEntries<T>(
	plan: ResolutionPlan,
	resolution: KeyedResolution<T>,
	decided: ReadonlyMap<string, ChoiceSide>,
): Map<string, T> | undefined {
	if (plan.pending.some((item) => !decided.has(item.key))) {
		return undefined;
	}
	const final = new Map(resolution.resolved);
	for (const item of plan.pending) {
		const side = decided.get(item.key) as ChoiceSide;
		// 消した側を採ったなら、**消えたままにする**（祖先の値を書き戻さない）
		if (side === "ours" ? item.oursDeleted : item.theirsDeleted) {
			final.delete(item.key);
			continue;
		}
		const chosen = (side === "ours" ? resolution.sides.ours : resolution.sides.theirs).get(item.key);
		if (chosen) {
			final.set(item.key, chosen);
		}
	}
	return final;
}

/** まだ決まっていない件数 */
export function countUndecided(plan: ResolutionPlan, decided: ReadonlyMap<string, ChoiceSide>): number {
	return plan.pending.filter((item) => !decided.has(item.key)).length;
}
