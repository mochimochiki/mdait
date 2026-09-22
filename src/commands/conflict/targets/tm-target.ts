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
import { mergeFieldMaps } from "../../../core/conflict/key-merge";
import { TmxStore } from "../../../core/tm/tmx-store";
import type { TmEntry, TmVariant } from "../../../core/tm/types";
import type { ChoiceSide, ResolutionPlan } from "../resolution-plan";
import {
	type KeyedResolution,
	countUndecided,
	finalEntries,
	planKeyedResolution,
	splitForResolution,
} from "./keyed-target";

/** 解いた結果を組み立てるための持ち物（計画と一緒に持ち回る） */
export type TmResolution = KeyedResolution<TmEntry>;

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

const sameVariant = (a: TmVariant, b: TmVariant) => JSON.stringify(a) === JSON.stringify(b);

/** 2つの TU が同じか（＝どちらを採っても結果が変わらないか） */
function sameEntry(a: TmEntry, b: TmEntry): boolean {
	if (a.primary !== b.primary || a.variants.size !== b.variants.size) {
		return false;
	}
	for (const [lang, variant] of a.variants) {
		const other = b.variants.get(lang);
		if (!other || !sameVariant(variant, other)) {
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
 * まるごと消える。言語を鍵にして TU と同じ規則で突き合わせ、重なっていたら `undefined` を
 * 返して人に決めてもらう。
 */
function mergeVariants(ours: TmEntry, theirs: TmEntry, base: TmEntry | undefined): TmEntry | undefined {
	if (ours.primary !== theirs.primary) {
		return undefined; // 同じ tuid で原文が違う（衝突か正規化の揺れ）。機械では決められない
	}
	const variants = mergeFieldMaps(ours.variants, theirs.variants, base?.variants, sameVariant);
	return variants ? { tuid: ours.tuid, primary: ours.primary, variants } : undefined;
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
	const split = splitForResolution(fs.readFileSync(filePath, "utf-8"));
	if (!split) {
		return undefined;
	}
	const sides = {
		ours: TmxStore.parseSide(split.ours),
		theirs: TmxStore.parseSide(split.theirs),
		base: split.base ? TmxStore.parseSide(split.base) : undefined,
	};
	return planKeyedResolution("tm", filePath, sides, {
		sameValue: sameEntry,
		mergeFields: mergeVariants,
		describe: (entry) => describe(entry, primaryLang),
		labelOf: (item) => item.ours.primary,
	});
}

/**
 * 人が決めた分を足して書き戻す。
 *
 * **書き出しは `TmxStore` の中の入口を通る**（ADR-260911-02）。原子的な書き込みと
 * 保存後の mtime の記録はそこにしか無い。
 *
 * @param decided 決まった件（決まらなかった件は含めない）
 * @returns 決まらずに残した件数。1件でも残れば1バイトも書かない
 */
export function applyTmResolution(
	filePath: string,
	plan: ResolutionPlan,
	resolution: TmResolution,
	decided: ReadonlyMap<string, ChoiceSide>,
): { remainingCount: number } {
	const final = finalEntries(plan, resolution, decided);
	if (!final) {
		return { remainingCount: countUndecided(plan, decided) };
	}
	TmxStore.getInstance(filePath).writeResolved(filePath, final);
	return { remainingCount: 0 };
}
