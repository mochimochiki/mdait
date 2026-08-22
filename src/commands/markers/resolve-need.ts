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
import * as fs from "node:fs"; // @important Node.jsのbuilt-inモジュールのimportでは`node:`を使用
import type { FrontMatter } from "../../core/markdown/front-matter";
import { parseFrontmatterMarker, setFrontmatterMarker } from "../../core/markdown/frontmatter-translation";
import type { MdaitUnit } from "../../core/markdown/mdait-unit";
import { markdownParser } from "../../core/markdown/parser";
import type { Configuration } from "../../infra/config/configuration";
import { resolveMarkerIO } from "../../infra/config/marker-io";
import { Logger } from "../../infra/logging/logger";
import { FileExplorer } from "../../infra/workspace/file-explorer";
import { type UnitMutationResult, withMarkerOnlyMutation } from "./unit-mutation";

const logger = Logger.getInstance();

/**
 * 既定で解決対象とする need 種別（translate / revise は明示指定時のみ解決する）。
 * verify-deletion は既定に含めない: need を外すだけでは from が残り、次の sync で
 * 確認待ちが復活する（Keep の恒久化は keep-unit.ts が need と from を同時に外す）。
 * 明示指定（needs:["verify-deletion"]）は一時的に伏せる操作として引き続き通る。
 */
export const DEFAULT_RESOLVABLE_NEEDS: readonly string[] = ["review"];

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
	/**
	 * 訳文が原文とまったく同じでも `translate` / `revise` を解決する。
	 *
	 * 既定（false）では「訳していないのに翻訳済みになる」のを防ぐために止める。
	 * コードブロックだけのユニットや原文のままが正しい見出しなど、同一が正しい場合は
	 * 利用者に確認したうえでこのフラグで通す（ADR-260802-01）。
	 */
	allowSameAsSource?: boolean;
}

/**
 * 「訳文が原文と同じか」を判定するための原文テキスト供給元。
 * ユニットの `from` ハッシュから原文本文を引く（引けなければ判定しない）。
 */
export type SourceTextLookup = (fromHash: string) => string | undefined;

/** 同一テキスト検査の対象となる need（訳したかどうかを問う need だけ） */
const SAME_TEXT_GUARDED_NEEDS = ["translate", "revise"] as const;

/** need が同一テキスト検査の対象か */
function isSameTextGuarded(need: string): boolean {
	return SAME_TEXT_GUARDED_NEEDS.some((guarded) => need === guarded || need.startsWith(`${guarded}@`));
}

/** 比較用にテキストを正規化する（前後の空白と改行コードの差は無視する） */
function normalizeForComparison(text: string): string {
	return text.replace(/\r\n/g, "\n").trim();
}

/** 解決されたユニット */
export interface ResolvedNeedUnit {
	hash: string;
	title?: string;
	/** 除去した need フラグの生値 */
	need: string;
}

/** スキップ理由 */
export type NeedSkipReason = "not-found" | "already-resolved" | "need-not-selected" | "same-as-source";

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
export function applyNeedResolution(
	units: MdaitUnit[],
	options: NeedResolutionOptions = {},
	sourceText?: SourceTextLookup,
): NeedResolutionResult {
	const selected = options.needs && options.needs.length > 0 ? options.needs : [...DEFAULT_RESOLVABLE_NEEDS];
	const resolved: ResolvedNeedUnit[] = [];
	const skipped: SkippedNeedUnit[] = [];
	const hashes = unitHashesFrom(options.targets);

	/**
	 * 訳文が原文とまったく同じなら、まだ訳していない可能性が高いので解決しない。
	 * 原文が引けないとき（供給元なし・from なし）は判定せず通す（誤って止めない）。
	 */
	const isUntranslated = (unit: MdaitUnit, need: string): boolean => {
		if (options.allowSameAsSource || !sourceText || !isSameTextGuarded(need)) {
			return false;
		}
		const from = unit.marker?.from;
		if (!from) {
			return false;
		}
		const source = sourceText(from);
		return source !== undefined && normalizeForComparison(source) === normalizeForComparison(unit.content);
	};

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
			if (isUntranslated(unit, need)) {
				skipped.push({ hash, reason: "same-as-source" });
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
			if (isUntranslated(unit, need)) {
				skipped.push({ hash: unit.marker?.hash ?? "", reason: "same-as-source" });
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
 * 訳文ファイルに対応する原文を読み、`from` ハッシュから原文本文を引ける関数を返す。
 *
 * 原文が見つからない・読めない場合は undefined を返し、同一テキスト検査は行われない
 * （検査できないことを理由に操作を止めない）。
 */
function loadSourceTextLookup(targetPath: string, config: Configuration): SourceTextLookup | undefined {
	try {
		const fileExplorer = new FileExplorer();
		const pair = fileExplorer.getTransPairFromTarget(targetPath, config);
		if (!pair) {
			return undefined;
		}
		const sourcePath = fileExplorer.getSourcePath(targetPath, pair);
		if (!sourcePath || !fs.existsSync(sourcePath)) {
			return undefined;
		}
		const io = resolveMarkerIO(config, sourcePath, "source");
		const parsed = markdownParser.parse(fs.readFileSync(sourcePath, "utf-8"), config, io.provider, io.ctx);
		const byHash = new Map<string, string>();
		for (const unit of parsed.units) {
			if (unit.marker?.hash) {
				byHash.set(unit.marker.hash, unit.content);
			}
		}
		return (fromHash: string) => byHash.get(fromHash);
	} catch {
		return undefined;
	}
}

/**
 * 1ファイル分の need フラグ解決を実行する（Markdown）。
 *
 * 排他制御・未保存の反映・ストア保存・ステータス更新は `withMarkerOnlyMutation` が担う。
 * need 解除はマーカーしか変えないため、external では本文へ1バイトも書き込まない
 * （原文・訳文とも。原稿の改行コードや空行の入れ方は保たれる）。
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
	// 同一テキスト検査に使う原文（必要なときだけ読む）
	const sourceText =
		options.allowSameAsSource || !selected.some((need) => isSameTextGuarded(need))
			? undefined
			: loadSourceTextLookup(absPath, config);

	const outcome = await withMarkerOnlyMutation<ResolveNeedFileResult>(absPath, config, ({ parsed }) => {
		const result = applyNeedResolution(parsed.units, options, sourceText);

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
