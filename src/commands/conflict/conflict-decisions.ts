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

/**
 * ファイルの絶対パス → そのときのファイルの見た目と、決まっているぶん。
 *
 * **見た目を一緒に持つ。** 決めかけのあいだにファイルが外から変わったら（別の合流が
 * 来た・人が手で直した）、前の鍵に対する判断はもう当てにならない。同じ鍵が新しい競合にも
 * 現れると、人が見ていないのに決まったことにされてしまう。
 */
const decisions = new Map<string, { stamp: string; choices: Map<string, ChoiceSide> }>();

/** その預かりが、いまのファイルの見た目のものか。違えば捨てる */
function liveChoices(filePath: string, stamp: string): Map<string, ChoiceSide> | undefined {
	const held = decisions.get(filePath);
	if (!held) {
		return undefined;
	}
	if (held.stamp !== stamp) {
		decisions.delete(filePath);
		return undefined;
	}
	return held.choices;
}

/**
 * 1件ぶんの判断を預かる。
 *
 * @param stamp 計画を作ったときのファイルの見た目（`PreparedResolution.stamps`）
 */
export function rememberDecision(filePath: string, stamp: string, key: string, side: ChoiceSide): void {
	const choices = liveChoices(filePath, stamp) ?? new Map<string, ChoiceSide>();
	choices.set(key, side);
	decisions.set(filePath, { stamp, choices });
}

/** そのファイルについて、いままでに決まっているぶん（見た目が変わっていれば空） */
export function decisionsFor(filePath: string, stamp: string): ReadonlyMap<string, ChoiceSide> {
	return liveChoices(filePath, stamp) ?? new Map<string, ChoiceSide>();
}

/** その1件に下した判断（まだなら `undefined`） */
export function decisionOf(filePath: string, stamp: string, key: string): ChoiceSide | undefined {
	return liveChoices(filePath, stamp)?.get(key);
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
