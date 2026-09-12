/**
 * @file terms-target.ts
 * @description
 *   用語集の競合を解く（roadmap-v04 P02）。
 *
 *   鍵は **主言語の用語 + 文脈**（`${primary}:${term}::${context}`。リポジトリの中の鍵と
 *   同じ作り）。実ファイルの名前は `terms.filename` で変えられ、拡張子で CSV か YAML かが
 *   決まるので、**読み書きは必ずリポジトリを通す** — この係は形式を知らない。
 *
 *   用語集は、合流で黙って片方を捨てていた2つのうちの片方である（CSV の畳み込みは跡を
 *   1つも残さなかった）。**言語ごとに触った先が別なら両方採る** — 片方が ja の訳語を、
 *   片方が fr の訳語を足しただけで、二択にすると片方の言語がまるごと消える。
 *
 * @module commands/conflict/targets/terms-target
 */
import * as fs from "node:fs";
import { splitConflictedFile } from "../../../core/conflict/conflict-sections";
import { type KeyedEntry, mergeByKey } from "../../../core/conflict/key-merge";
import type { LangTerm, TermEntry } from "../../term/term-entry";
import { TermEntry as TermEntryUtils } from "../../term/term-entry";
import type { TermsRepository } from "../../term/terms-repository";
import type { ChoiceSide, PendingChoice, ResolutionPlan } from "../resolution-plan";

/** 判定に必要な材料 */
interface TermSides {
	ours: Map<string, TermEntry>;
	theirs: Map<string, TermEntry>;
	base?: Map<string, TermEntry>;
}

/** 解いた結果を組み立てるための持ち物 */
export interface TermsResolution {
	sides: TermSides;
	resolved: Map<string, TermEntry>;
}

/** リポジトリの中の鍵と同じ作り（主言語の用語 + 文脈） */
function entryKey(entry: TermEntry, primaryLang: string): string {
	return `${primaryLang}:${TermEntryUtils.getTerm(entry, primaryLang) ?? ""}::${entry.context}`;
}

/** 言語1つぶんが同じか */
function sameLang(a: LangTerm | undefined, b: LangTerm | undefined): boolean {
	if (!a || !b) {
		return a === b;
	}
	return a.term === b.term && a.variants.join(" ") === b.variants.join(" ");
}

/** 2つの語が同じか */
function sameEntry(a: TermEntry, b: TermEntry): boolean {
	if (a.context !== b.context) {
		return false;
	}
	const langs = new Set([...Object.keys(a.languages), ...Object.keys(b.languages)]);
	for (const lang of langs) {
		if (!sameLang(a.languages[lang], b.languages[lang])) {
			return false;
		}
	}
	return true;
}

/** 語を人が読める1行にする */
function describe(entry: TermEntry): string {
	const langs = Object.keys(entry.languages).sort();
	const body = langs.map((lang) => `${lang}: ${entry.languages[lang].term}`).join(" / ");
	return entry.context ? `${body} — ${entry.context}` : body;
}

/**
 * **言語ごとに触った先が別なら、両方採る。**
 *
 * 片方が ja の訳語を、片方が fr の訳語を足しただけの形がこれにあたる。二択で解かせると
 * 片方の言語がまるごと消える。同じ言語を2人が別々に直していたら `undefined` を返す。
 */
function mergeLanguages(ours: TermEntry, theirs: TermEntry, base: TermEntry | undefined): TermEntry | undefined {
	if (ours.context !== theirs.context) {
		return undefined; // 文脈そのものが違う。機械では決められない
	}
	const langs = new Set([...Object.keys(ours.languages), ...Object.keys(theirs.languages)]);
	const merged: Record<string, LangTerm> = { ...ours.languages };
	for (const lang of langs) {
		const mine = ours.languages[lang];
		const yours = theirs.languages[lang];
		if (!mine) {
			merged[lang] = yours;
			continue;
		}
		if (!yours || sameLang(mine, yours)) {
			continue;
		}
		const ancestor = base?.languages[lang];
		if (ancestor) {
			if (sameLang(mine, ancestor)) {
				merged[lang] = yours;
				continue;
			}
			if (sameLang(yours, ancestor)) {
				continue;
			}
		}
		return undefined; // 2人が同じ言語の訳語を別々に直した。人が決める
	}
	return TermEntryUtils.create(ours.context, merged);
}

const toKeyed = (entries: readonly TermEntry[], primaryLang: string): KeyedEntry<TermEntry>[] =>
	entries.map((value) => ({ key: entryKey(value, primaryLang), value }));

const toMap = (entries: readonly TermEntry[], primaryLang: string): Map<string, TermEntry> =>
	new Map(entries.map((entry) => [entryKey(entry, primaryLang), entry]));

/**
 * 用語集の競合を読み、決定的に決まるものと決まらないものに分ける。**1バイトも書かない。**
 *
 * **自分の側を後に読む。** リポジトリは読んだぶんの付帯情報（CSV の未知列・列の順、
 * YAML のメタデータ）を引き取るので、手元の作業場の形が残るようにする。
 *
 * @returns 競合していなければ `undefined`
 */
export async function planTermsResolution(
	filePath: string,
	repository: TermsRepository,
	primaryLang: string,
): Promise<{ plan: ResolutionPlan; resolution: TermsResolution } | undefined> {
	const content = fs.readFileSync(filePath, "utf-8");
	const split = splitConflictedFile(content);
	if (!split.conflicted) {
		return undefined;
	}

	const base = split.base ? await repository.loadSide(split.base) : undefined;
	const theirs = await repository.loadSide(split.theirs);
	const ours = await repository.loadSide(split.ours);

	const merged = mergeByKey(
		toKeyed(ours, primaryLang),
		toKeyed(theirs, primaryLang),
		base ? toKeyed(base, primaryLang) : undefined,
		{ sameValue: sameEntry, mergeFields: mergeLanguages },
	);

	const pending: PendingChoice[] = merged.undecided.map((item) => ({
		key: item.key,
		label: TermEntryUtils.getTerm(item.ours, primaryLang) ?? item.key,
		oursText: describe(item.ours),
		theirsText: describe(item.theirs),
		baseText: item.base ? describe(item.base) : undefined,
	}));

	return {
		plan: {
			kind: "terms",
			filePath,
			autoResolvedCount: merged.resolved.length,
			deletedKeys: merged.deleted,
			pending,
			hasBase: split.base !== undefined,
		},
		resolution: {
			sides: {
				ours: toMap(ours, primaryLang),
				theirs: toMap(theirs, primaryLang),
				base: base ? toMap(base, primaryLang) : undefined,
			},
			resolved: new Map(merged.resolved.map((r) => [r.key, r.value])),
		},
	};
}

/**
 * 判定の結果を足して書き戻す。**書き出しはリポジトリの中の入口を通る。**
 *
 * 決まらない件が1つでも残っていれば1バイトも書かない（半端に書き戻すと、残った件の
 * 両側がディスクから消える）。
 */
export async function applyTermsResolution(
	plan: ResolutionPlan,
	resolution: TermsResolution,
	repository: TermsRepository,
	decided: ReadonlyMap<string, ChoiceSide>,
): Promise<{ decidedCount: number; remainingCount: number }> {
	const final = new Map(resolution.resolved);
	let decidedCount = 0;
	let remainingCount = 0;

	for (const item of plan.pending) {
		const side = decided.get(item.key);
		if (!side) {
			remainingCount++;
			continue;
		}
		const chosen = (side === "ours" ? resolution.sides.ours : resolution.sides.theirs).get(item.key);
		if (chosen) {
			final.set(item.key, chosen);
			decidedCount++;
		}
	}

	if (remainingCount > 0) {
		return { decidedCount: 0, remainingCount };
	}

	await repository.writeResolved([...final.values()]);
	return { decidedCount, remainingCount: 0 };
}
