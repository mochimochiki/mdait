/**
 * @file resolve-need.ts
 * @description
 *   need フラグ解決（除去）の Markdown 実装。マーカー変異は `removeNeedTag()` のみで、
 *   hash / from / 本文には一切触れない。
 *
 *   本文ユニットと frontmatter マーカーの両方を扱う。呼び出し口は `MdFileHandler.resolveNeed`
 *   に一本化されており、CodeLens・ツリー・LM Tool はそこを経由する
 *   （サーフェスごとに書き換えを実装しないこと。理由は unit-mutation.ts を参照）。
 * @module commands/markers/resolve-need
 */
import type { FrontMatter } from "../../core/markdown/front-matter";
import { parseFrontmatterMarker, setFrontmatterMarker } from "../../core/markdown/frontmatter-translation";
import type { MdaitUnit } from "../../core/markdown/mdait-unit";
import type { Configuration } from "../../infra/config/configuration";
import { Logger } from "../../infra/logging/logger";
import { type UnitMutationResult, withMarkdownMutation } from "./unit-mutation";

const logger = Logger.getInstance();

/** 既定で解決対象とする need 種別（translate / revise は明示指定時のみ解決する） */
export const DEFAULT_RESOLVABLE_NEEDS: readonly string[] = ["review", "verify-deletion"];

/**
 * 解決対象に指定できる need 種別の全て。need 語彙の持ち主はこのモジュールであり、
 * サーフェスごとに同じ配列を書かないこと（CodeLens の「完了マーク」と LM Tool の
 * 入力検証が別々に持っていたため、語彙を足すと片方だけ取り残される状態だった）。
 * `revise` は `revise@{oldhash}` 形式にも一致する（needMatchesSelection）。
 */
export const ALL_RESOLVABLE_NEEDS: readonly string[] = ["translate", "revise", "review", "verify-deletion", "isolate"];

/**
 * need 解決の対象指定。
 * - `{ kind: "unit" }`: 本文ユニット（hash で特定）
 * - `{ kind: "frontmatter" }`: frontmatter の mdait.front マーカー
 * - `{ kind: "file" }`: ファイル＝1ユニット（非Markdown。PlainFileHandler が扱う）
 */
export type NeedTarget = { kind: "unit"; hash: string } | { kind: "frontmatter" } | { kind: "file" };

/** 解決対象の選択オプション */
export interface NeedResolutionOptions {
	/** 対象。省略時は needs フィルタに一致するファイル内の全ユニット（frontmatter を含む） */
	targets?: NeedTarget[];
	/** 解決対象の need 種別フィルタ。省略時は DEFAULT_RESOLVABLE_NEEDS */
	needs?: readonly string[];
}

/** 解決されたユニット */
export interface ResolvedNeedUnit {
	hash: string;
	title?: string;
	/** 除去した need フラグの生値 */
	need: string;
}

/** スキップ理由 */
export type NeedSkipReason = "not-found" | "already-resolved" | "need-not-selected";

/** スキップされたユニット */
export interface SkippedNeedUnit {
	hash: string;
	reason: NeedSkipReason;
}

/** applyNeedResolution の結果 */
export interface NeedResolutionResult extends UnitMutationResult {
	resolved: ResolvedNeedUnit[];
	skipped: SkippedNeedUnit[];
}

/** resolveNeedForFile の結果 */
export interface ResolveNeedFileResult extends NeedResolutionResult {
	/** 解決後にファイル内へ残っている need フラグの生値一覧（内訳集計は呼び出し側で行う） */
	remainingNeedFlags: string[];
}

/**
 * need フラグが選択フィルタに一致するかを判定する。
 * "revise" 指定は revise@{oldhash} 形式にも一致する。
 */
export function needMatchesSelection(need: string, selected: readonly string[]): boolean {
	if (selected.includes(need)) {
		return true;
	}
	return selected.includes("revise") && need.startsWith("revise@");
}

function toResolvedUnit(unit: MdaitUnit, removedNeed: string): ResolvedNeedUnit {
	const resolved: ResolvedNeedUnit = {
		hash: unit.marker?.hash ?? "",
		need: removedNeed,
	};
	if (unit.title) {
		resolved.title = unit.title;
	}
	return resolved;
}

/**
 * hash の配列を本文ユニットの対象指定へ変換する。
 * 空・未指定は undefined（＝ファイル内全件）を返す。
 */
export function unitTargets(hashes: string[] | undefined): NeedTarget[] | undefined {
	return hashes && hashes.length > 0 ? hashes.map((hash) => ({ kind: "unit" as const, hash })) : undefined;
}

/** targets から本文ユニットの hash 一覧を取り出す（未指定＝全件は undefined を返す） */
function unitHashesFrom(targets: NeedTarget[] | undefined): string[] | undefined {
	if (!targets) {
		return undefined;
	}
	return targets.filter((t): t is { kind: "unit"; hash: string } => t.kind === "unit").map((t) => t.hash);
}

/** targets に frontmatter が含まれるか（未指定＝全件なら true） */
function includesFrontmatter(targets: NeedTarget[] | undefined): boolean {
	return !targets || targets.some((t) => t.kind === "frontmatter");
}

/**
 * パース済みユニット列に対して need フラグ解決を適用する（純関数的コア。VS Code 非依存）。
 * マーカーの need のみを除去し、hash / from / 本文には触れない。冪等:
 * 同じ入力で2回目を実行すると resolved は 0 件になる（hash 指定時は already-resolved でスキップ）。
 *
 * @param units パース済みユニット（マーカーを直接変異させる）
 * @param options 対象選択オプション
 */
export function applyNeedResolution(units: MdaitUnit[], options: NeedResolutionOptions = {}): NeedResolutionResult {
	const selected = options.needs && options.needs.length > 0 ? options.needs : [...DEFAULT_RESOLVABLE_NEEDS];
	const resolved: ResolvedNeedUnit[] = [];
	const skipped: SkippedNeedUnit[] = [];
	const hashes = unitHashesFrom(options.targets);

	if (hashes && hashes.length > 0) {
		for (const hash of hashes) {
			const unit = units.find((u) => u.marker?.hash === hash);
			if (!unit?.marker) {
				skipped.push({ hash, reason: "not-found" });
				continue;
			}
			const need = unit.marker.need;
			if (!need) {
				skipped.push({ hash, reason: "already-resolved" });
				continue;
			}
			if (!needMatchesSelection(need, selected)) {
				skipped.push({ hash, reason: "need-not-selected" });
				continue;
			}
			unit.marker.removeNeedTag();
			resolved.push(toResolvedUnit(unit, need));
		}
	} else if (!options.targets) {
		// 対象未指定: needs フィルタに一致する全ユニット
		for (const unit of units) {
			const need = unit.marker?.need;
			if (!need || !needMatchesSelection(need, selected)) {
				continue;
			}
			unit.marker?.removeNeedTag();
			resolved.push(toResolvedUnit(unit, need));
		}
	}

	return { resolved, skipped, changed: resolved.length > 0 };
}

/**
 * frontmatter マーカーの need を解決する（純関数的コア）。
 * hash / from は保持したまま need のみを外す。
 *
 * @param frontMatter パース済み frontmatter（直接変異させる）
 * @param selected 解決対象の need 種別
 */
export function applyFrontmatterNeedResolution(
	frontMatter: FrontMatter | undefined,
	selected: readonly string[],
): ResolvedNeedUnit | null {
	const marker = parseFrontmatterMarker(frontMatter);
	if (!frontMatter || !marker?.need || !needMatchesSelection(marker.need, selected)) {
		return null;
	}
	const removed = marker.need;
	marker.removeNeedTag();
	setFrontmatterMarker(frontMatter, marker);
	return { hash: marker.hash, need: removed };
}

/**
 * 1ファイル分の need フラグ解決を実行する（Markdown）。
 *
 * 排他制御・未保存の反映・ストア保存・ステータス更新は `withMarkdownMutation` が担う。
 * 変更が無ければファイルへは書き込まない（冪等）。
 *
 * @param absPath 対象ファイルの絶対パス
 * @param config 設定
 * @param options 対象選択オプション
 */
export async function resolveNeedForFile(
	absPath: string,
	config: Configuration,
	options: NeedResolutionOptions = {},
): Promise<ResolveNeedFileResult> {
	const selected = options.needs && options.needs.length > 0 ? options.needs : [...DEFAULT_RESOLVABLE_NEEDS];

	const outcome = await withMarkdownMutation<ResolveNeedFileResult>(absPath, config, ({ parsed }) => {
		const result = applyNeedResolution(parsed.units, options);

		if (includesFrontmatter(options.targets)) {
			const fm = applyFrontmatterNeedResolution(parsed.frontMatter, selected);
			if (fm) {
				result.resolved.push(fm);
				result.changed = true;
			}
		}

		const remainingNeedFlags = parsed.units.map((unit) => unit.marker?.need).filter((need): need is string => !!need);
		return { ...result, remainingNeedFlags };
	});

	logger.info("resolve", "Need flags resolved", {
		file: absPath,
		resolved: outcome.resolved.length,
		skipped: outcome.skipped.length,
	});
	return outcome;
}
