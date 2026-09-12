/**
 * @file conflict-decisions.ts
 * @description
 *   人が行ごとに下した判断を、書き戻せるようになるまで預かる（roadmap-v04 P03）。
 *
 *   なぜ預かるのか。**決まらない件が1つでも残っている対象は1バイトも書かない**からである
 *   （半端に書き戻すと、残った件の両側がディスクから消える）。人は1件ずつ決めていくので、
 *   最後の1件が決まるまでのあいだ、決めたぶんをどこかへ置いておく必要がある。
 *
 *   **ディスクには書かない。** 置き場はこのセッションのメモリだけである。VS Code を
 *   読み込み直すと決めたぶんは消えるが、**壊れるものは何も無い** — ファイルは競合マーカーの
 *   入ったまま残っているので、もう一度決め直せばよい。決めかけを別のファイルへ書き出すと、
 *   「その控えの寿命は誰が決めるのか」という未決事項がまた1つ増える（ADR-260806-01 と
 *   同じ理屈）。
 *
 * @module commands/conflict/conflict-decisions
 */
import type { ChoiceSide } from "./resolution-plan";

/** ファイルの絶対パス → 鍵 → どちらを採るか */
const decisions = new Map<string, Map<string, ChoiceSide>>();

/** 1件ぶんの判断を預かる */
export function rememberDecision(filePath: string, key: string, side: ChoiceSide): void {
	const perFile = decisions.get(filePath) ?? new Map<string, ChoiceSide>();
	perFile.set(key, side);
	decisions.set(filePath, perFile);
}

/** そのファイルについて、いままでに決まっているぶん */
export function decisionsFor(filePath: string): ReadonlyMap<string, ChoiceSide> {
	return decisions.get(filePath) ?? new Map<string, ChoiceSide>();
}

/** その1件に下した判断（まだなら `undefined`） */
export function decisionOf(filePath: string, key: string): ChoiceSide | undefined {
	return decisions.get(filePath)?.get(key);
}

/**
 * そのファイルの預かりを捨てる。
 *
 * 書き戻せたときと、ファイルが外から変わったとき（別の合流が来た・人が手で直した）に呼ぶ。
 * 古い鍵に対する判断を持ち越すと、別の競合に誤って当たりうる。
 */
export function forgetDecisions(filePath: string): void {
	decisions.delete(filePath);
}

/** すべての預かりを捨てる（作業場が変わったとき・テスト用） */
export function forgetAllDecisions(): void {
	decisions.clear();
}
