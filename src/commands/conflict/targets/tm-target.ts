/**
 * @file tm-target.ts
 * @description
 *   翻訳メモリ（`translations.tmx`）の競合を解く（roadmap-v04 P02）。
 *
 *   鍵は **tuid**（原文の CRC32）。1 TU = 1 行で書いているので（ADR-260908-01）競合の
 *   範囲は狭く、両陣営の版をそのまま切り出せる。
 *
 *   **人の判断が要るのは「同じ tuid に別の訳」だけ**である。2人が別々の文を登録しただけの
 *   形（実測で 16/20・18/20 と、いちばん多い）は鍵の突き合わせで決定的に両方採る。
 *
 * @module commands/conflict/targets/tm-target
 */
import * as fs from "node:fs";
import { splitConflictedFile } from "../../../core/conflict/conflict-sections";
import { type KeyedEntry, mergeByKey } from "../../../core/conflict/key-merge";
import { TmxStore } from "../../../core/tm/tmx-store";
import type { TmEntry } from "../../../core/tm/types";
import type { ChoiceSide, PendingChoice, ResolutionPlan } from "../resolution-plan";
import { REMOVED_TEXT } from "../resolution-plan";

/** 判定に必要な材料を、計画の外へ持ち出さずに抱えておく */
interface TmSides {
	ours: Map<string, TmEntry>;
	theirs: Map<string, TmEntry>;
	base?: Map<string, TmEntry>;
}

/**
 * TU を人が読める1行にする。
 *
 * **原文は出さない。** 見出しに出ているものを値の欄でも繰り返すと、両者の違いが
 * 埋もれる（実測: 3行のうち3行が同じ原文で始まっていた）。言語が1つなら訳だけを、
 * 2つ以上あるなら言語名を添えて並べる。
 */
function describe(entry: TmEntry, primaryLang: string): string {
	const translations = [...entry.variants.entries()]
		.filter(([lang]) => lang !== primaryLang)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	if (translations.length === 0) {
		return entry.primary;
	}
	if (translations.length === 1) {
		return translations[0][1].text ?? "";
	}
	return translations.map(([lang, variant]) => `${lang}: ${variant.text ?? ""}`).join(" / ");
}

/** 2つの TU が同じか（＝どちらを採っても結果が変わらないか） */
function sameEntry(a: TmEntry, b: TmEntry): boolean {
	if (a.primary !== b.primary || a.variants.size !== b.variants.size) {
		return false;
	}
	for (const [lang, variant] of a.variants) {
		if (JSON.stringify(variant) !== JSON.stringify(b.variants.get(lang))) {
			return false;
		}
	}
	return true;
}

/**
 * **言語ごとに触った先が別なら、両方採る。**
 *
 * 同じ原文に、片方が ja の訳を、片方が fr の訳を登録した形がこれにあたる。TU としては
 * 「同じ tuid に別の値」だが、**訳が重なっていない**ので二択で解かせるとどちらかの言語が
 * まるごと消える。重なっていたら `undefined` を返して人に決めてもらう。
 */
function mergeVariants(ours: TmEntry, theirs: TmEntry, base: TmEntry | undefined): TmEntry | undefined {
	if (ours.primary !== theirs.primary) {
		return undefined; // 同じ tuid で原文が違う（衝突か正規化の揺れ）。機械では決められない
	}
	const langs = new Set([...ours.variants.keys(), ...theirs.variants.keys()]);
	const merged = new Map(ours.variants);
	for (const lang of langs) {
		const mine = ours.variants.get(lang);
		const yours = theirs.variants.get(lang);
		const ancestor = base?.variants.get(lang);

		// **片方にしか無い言語。** 祖先に無ければ「足した」なので採る。祖先に在れば
		// 「消した」なので、残っている側が祖先のままなら消す。残っている側も直していたら
		// 「消した」と「直した」がぶつかっているので、TU ごと人に決めてもらう
		if (mine === undefined || yours === undefined) {
			const present = (mine ?? yours) as NonNullable<typeof mine>;
			if (ancestor === undefined) {
				merged.set(lang, present);
				continue;
			}
			if (JSON.stringify(present) === JSON.stringify(ancestor)) {
				merged.delete(lang);
				continue;
			}
			return undefined;
		}
		if (JSON.stringify(mine) === JSON.stringify(yours)) {
			continue;
		}
		// 同じ言語に別の訳。祖先を見て片方だけが変えたなら、変えたほうを採る
		if (ancestor !== undefined) {
			if (JSON.stringify(mine) === JSON.stringify(ancestor)) {
				merged.set(lang, yours);
				continue;
			}
			if (JSON.stringify(yours) === JSON.stringify(ancestor)) {
				continue;
			}
		}
		return undefined; // 2人が同じ言語の訳を別々に直した。人が決める
	}
	if (merged.size === 0) {
		return undefined; // 訳が1つも残らない。畳まずに人へ回す
	}
	return { tuid: ours.tuid, primary: ours.primary, variants: merged };
}

const toEntries = (index: Map<string, TmEntry>): KeyedEntry<TmEntry>[] =>
	[...index.entries()].map(([key, value]) => ({ key, value }));

/** 解いた結果を組み立てるための持ち物（計画と一緒に持ち回る） */
export interface TmResolution {
	sides: TmSides;
	/** 決定的に決まった分 */
	resolved: Map<string, TmEntry>;
}

/**
 * 翻訳メモリの競合を読み、決定的に決まるものと決まらないものに分ける。**1バイトも書かない。**
 *
 * @returns 競合していなければ `undefined`
 */
export function planTmResolution(
	filePath: string,
	primaryLang = "",
): { plan: ResolutionPlan; resolution: TmResolution } | undefined {
	const xml = fs.readFileSync(filePath, "utf-8");
	const split = splitConflictedFile(xml);
	if (!split.conflicted) {
		return undefined;
	}

	const sides: TmSides = {
		ours: TmxStore.parseSide(split.ours),
		theirs: TmxStore.parseSide(split.theirs),
		base: split.base ? TmxStore.parseSide(split.base) : undefined,
	};
	const merged = mergeByKey(toEntries(sides.ours), toEntries(sides.theirs), sides.base ? toEntries(sides.base) : undefined, {
		sameValue: sameEntry,
		mergeFields: mergeVariants,
	});

	const pending: PendingChoice[] = merged.undecided.map((item) => ({
		key: item.key,
		label: item.ours.primary,
		// 消した側には見せる値が無い。祖先の値ではなく「消した」と出す — 値を出すと、
		// その側を採れば値が戻ると読めてしまう
		oursText: item.oursDeleted ? REMOVED_TEXT : describe(item.ours, primaryLang),
		theirsText: item.theirsDeleted ? REMOVED_TEXT : describe(item.theirs, primaryLang),
		baseText: item.base ? describe(item.base, primaryLang) : undefined,
		oursDeleted: item.oursDeleted,
		theirsDeleted: item.theirsDeleted,
	}));

	return {
		plan: {
			kind: "tm",
			filePath,
			autoResolvedCount: merged.resolved.length,
			deletedKeys: merged.deleted,
			pending,
			hasBase: split.base !== undefined,
		},
		resolution: { sides, resolved: new Map(merged.resolved.map((r) => [r.key, r.value])) },
	};
}

/**
 * 判定の結果を足して書き戻す。
 *
 * **書き出しは `TmxStore` の中の入口を通る**（ADR-260911-02）。原子的な書き込みと
 * 保存後の mtime の記録はそこにしか無い。
 *
 * @param decided 判定が決まった件（決まらなかった件は含めない）
 * @returns 書き戻した件数と、決まらずに残った件数
 */
export function applyTmResolution(
	filePath: string,
	plan: ResolutionPlan,
	resolution: TmResolution,
	decided: ReadonlyMap<string, ChoiceSide>,
): { decidedCount: number; remainingCount: number } {
	const final = new Map(resolution.resolved);
	let decidedCount = 0;
	let remainingCount = 0;

	for (const item of plan.pending) {
		const side = decided.get(item.key);
		if (!side) {
			// **迷った件は書かずに残す。** 両方の版を残せないので、この対象は書き戻さない
			remainingCount++;
			continue;
		}
		// 消した側を採ったなら、**消えたままにする**（祖先の値を書き戻さない）
		if (side === "ours" ? item.oursDeleted : item.theirsDeleted) {
			final.delete(item.key);
			decidedCount++;
			continue;
		}
		const chosen = (side === "ours" ? resolution.sides.ours : resolution.sides.theirs).get(item.key);
		if (chosen) {
			final.set(item.key, chosen);
			decidedCount++;
		}
	}

	if (remainingCount > 0) {
		// 決まらない件が1つでもあれば、ファイルは競合マーカーの入ったまま残す。
		// 半端に書き戻すと、残った件の両側がディスクから消える
		return { decidedCount: 0, remainingCount };
	}

	TmxStore.getInstance(filePath).writeResolved(filePath, final);
	return { decidedCount, remainingCount: 0 };
}
