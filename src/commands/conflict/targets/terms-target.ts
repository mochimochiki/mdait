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
import { mergeFieldMaps } from "../../../core/conflict/key-merge";
import type { LangTerm, TermEntry } from "../../term/term-entry";
import { TermEntry as TermEntryUtils } from "../../term/term-entry";
import type { TermsRepository } from "../../term/terms-repository";
import type { ChoiceSide, ResolutionPlan } from "../resolution-plan";
import {
	type KeyedResolution,
	countUndecided,
	finalEntries,
	planKeyedResolution,
	splitForResolution,
} from "./keyed-target";

/** 解いた結果を組み立てるための持ち物 */
export type TermsResolution = KeyedResolution<TermEntry>;

/** リポジトリの中の鍵と同じ作り（主言語の用語 + 文脈） */
function entryKey(entry: TermEntry, primaryLang: string): string {
	return `${primaryLang}:${TermEntryUtils.getTerm(entry, primaryLang) ?? ""}::${entry.context}`;
}

/** 表記揺れの一覧が同じか。**繋げて比べない** — `['a', 'b']` と `['a b']` は別物である */
function sameVariants(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((value, i) => value === b[i]);
}

/** 言語1つぶんが同じか */
function sameLang(a: LangTerm, b: LangTerm): boolean {
	return a.term === b.term && sameVariants(a.variants, b.variants);
}

/** 2つの語が同じか */
function sameEntry(a: TermEntry, b: TermEntry): boolean {
	if (a.context !== b.context) {
		return false;
	}
	const langs = new Set([...Object.keys(a.languages), ...Object.keys(b.languages)]);
	for (const lang of langs) {
		const mine = a.languages[lang];
		const yours = b.languages[lang];
		if (!mine || !yours ? mine !== yours : !sameLang(mine, yours)) {
			return false;
		}
	}
	return true;
}

/**
 * 語を人が読める1行にする。
 *
 * **主言語の語は出さない。** 見出しに出ているものを繰り返すと、訳語の違いが埋もれる。
 * 訳語が1つならそれだけを、2つ以上あるなら言語名を添えて並べる。
 */
function describe(entry: TermEntry, primaryLang: string): string {
	const langs = Object.keys(entry.languages)
		.filter((lang) => lang !== primaryLang)
		.sort();
	const body =
		langs.length === 1
			? entry.languages[langs[0]].term
			: langs.map((lang) => `${lang}: ${entry.languages[lang].term}`).join(" / ");
	return entry.context ? `${body} — ${entry.context}` : body;
}

const languageMap = (entry: TermEntry) => new Map(Object.entries(entry.languages));

/**
 * **言語ごとに触った先が別なら、両方採る。**
 *
 * 片方が ja の訳語を、片方が fr の訳語を足しただけの形がこれにあたる。二択で解かせると
 * 片方の言語がまるごと消える。言語を鍵にして語と同じ規則で突き合わせ、同じ言語を2人が
 * 別々に直していたら `undefined` を返す。
 */
function mergeLanguages(ours: TermEntry, theirs: TermEntry, base: TermEntry | undefined): TermEntry | undefined {
	if (ours.context !== theirs.context) {
		return undefined; // 文脈そのものが違う。機械では決められない
	}
	const merged = mergeFieldMaps(languageMap(ours), languageMap(theirs), base && languageMap(base), sameLang);
	if (!merged) {
		return undefined;
	}
	// 言語の並びは自分の側の順を保つ（YAML の書き出しはこの順に並ぶ）
	const order = [...new Set([...Object.keys(ours.languages), ...Object.keys(theirs.languages)])];
	const languages: Record<string, LangTerm> = {};
	for (const lang of order) {
		const term = merged.get(lang);
		if (term) {
			languages[lang] = term;
		}
	}
	return TermEntryUtils.create(ours.context, languages);
}

const toMap = (entries: readonly TermEntry[], primaryLang: string): Map<string, TermEntry> => {
	// 同じ鍵が2度来たら先に来たほうを残す（鍵の突き合わせと同じ規則）
	const map = new Map<string, TermEntry>();
	for (const entry of entries) {
		const key = entryKey(entry, primaryLang);
		if (!map.has(key)) {
			map.set(key, entry);
		}
	}
	return map;
};

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
	const split = splitForResolution(fs.readFileSync(filePath, "utf-8"));
	if (!split) {
		return undefined;
	}

	const base = split.base ? await repository.loadSide(split.base) : undefined;
	const theirs = await repository.loadSide(split.theirs);
	const ours = await repository.loadSide(split.ours);

	const sides = {
		ours: toMap(ours, primaryLang),
		theirs: toMap(theirs, primaryLang),
		base: base ? toMap(base, primaryLang) : undefined,
	};
	return planKeyedResolution("terms", filePath, sides, {
		sameValue: sameEntry,
		mergeFields: mergeLanguages,
		describe: (entry) => describe(entry, primaryLang),
		labelOf: (item) => TermEntryUtils.getTerm(item.ours, primaryLang) ?? item.key,
	});
}

/**
 * 人が決めた分を足して書き戻す。**書き出しはリポジトリの中の入口を通る。**
 *
 * 決まらない件が1つでも残っていれば1バイトも書かない（半端に書き戻すと、残った件の
 * 両側がディスクから消える）。
 */
export async function applyTermsResolution(
	plan: ResolutionPlan,
	resolution: TermsResolution,
	repository: TermsRepository,
	decided: ReadonlyMap<string, ChoiceSide>,
): Promise<{ remainingCount: number }> {
	const final = finalEntries(plan, resolution, decided);
	if (!final) {
		return { remainingCount: countUndecided(plan, decided) };
	}
	await repository.writeResolved([...final.values()]);
	return { remainingCount: 0 };
}
