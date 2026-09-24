/**
 * @file request-translate.ts
 * @description
 *   確認待ち（need:review）の既訳を「採用しない。訳し直してほしい」と印を付け直す
 *   （need:review → need:translate）。印を付けるだけで AI は呼ばない。実際に訳すのは
 *   その後の「✨翻訳」（翻訳待ちの通常の流れ）に任せる。
 *
 *   **なぜ resolveNeed と別なのか。** resolveNeed は need を外す＝「この訳でよい」の確定で、
 *   review に対して人が取れる手はそれしか無かった。「この訳は駄目」を表す道が無く、
 *   駄目な訳を手で消してから翻訳待ちにする、という回り道しか無かった。
 *
 *   **なぜ「全文で訳し直す」（retranslate）と別なのか。** retranslate はその場で AI を呼び、
 *   訳文を上書きする操作である。review は「取り込んだ既訳を AI の上書きから守る」ための
 *   状態なので、`isRetranslatableUnit` は review を意図的に除外している。ここは守りを
 *   外さず、「翻訳待ちの列へ戻す」だけを行う。列へ戻ったあとは他の翻訳待ちと同じ扱いになり、
 *   AI を呼ぶかどうかは人が改めて決める。
 *
 *   マーカーしか変えないので `withMarkerOnlyMutation` を通す（external では本文を書かない）。
 *   本文ユニットと frontmatter マーカーの両方を扱う（resolve-need.ts と同じ）。
 *   呼び出し口は `MdFileHandler.requestTranslate` に一本化されている
 *   （サーフェスごとに書き換えを実装しないこと。理由は unit-mutation.ts を参照）。
 * @module commands/markers/request-translate
 */
import { parseFrontmatterMarker, setFrontmatterMarker } from "../../core/markdown/frontmatter-translation";
import type { MdaitMarker } from "../../core/markdown/mdait-marker";
import type { Configuration } from "../../infra/config/configuration";
import { Logger } from "../../infra/logging/logger";
import type { NeedTarget } from "./resolve-need";
import { type UnitMutationResult, withMarkerOnlyMutation } from "./unit-mutation";

const logger = Logger.getInstance();

/**
 * スキップの理由。
 * - `not-found`: その hash のユニットが無い（frontmatter 指定ならマーカーが無い）
 * - `not-review`: need が review ではない（need なし・translate・revise・verify-deletion・isolate）。
 *   review 以外を translate に倒すと、訳し終えた本文や判断待ちを黙って翻訳待ちに戻してしまう
 */
export type RequestTranslateSkipReason = "not-found" | "not-review";

export interface RequestTranslateResult extends UnitMutationResult {
	/** need:review → need:translate に付け替えたか */
	requested: boolean;
	hash: string;
	title?: string;
	reason?: RequestTranslateSkipReason;
}

/** Markdown で「翻訳待ちに戻す」を受ける対象（ファイル＝1ユニットの非Markdown は PlainFileHandler が扱う） */
export type MarkdownRequestTranslateTarget = Extract<NeedTarget, { kind: "unit" | "frontmatter" }>;

/**
 * マーカーの need:review を need:translate に付け替える。**本文ユニットと frontmatter で唯一の判定。**
 * review 以外は変えない（訳し終えた本文や他の判断待ちを黙って翻訳待ちに戻さない）。
 *
 * @returns 付け替えたら null、しなかったら理由
 */
function sendBackToTranslation(marker: MdaitMarker | null | undefined): RequestTranslateSkipReason | null {
	if (!marker?.hash) {
		return "not-found";
	}
	if (marker.need !== "review") {
		return "not-review";
	}
	marker.setNeed("translate");
	return null;
}

/**
 * 指定した本文ユニット、または frontmatter の need:review を need:translate に付け替える。
 * need が review 以外のものは変更せず、理由つきでスキップする。
 *
 * frontmatter も同じ答えを受ける。frontmatter の確認待ちに「採用しない」の出口が無いと、
 * 取り込んだ既訳や手で書いた値（ADR-260923-07 で確認待ちに倒る）を、訳されないまま
 * 受け入れるしか道が無くなる（ADR-260923-09）。
 *
 * @param absPath 対象ファイルの絶対パス
 * @param target 本文ユニット（hash で指す）か frontmatter
 * @param config 設定
 */
export async function requestTranslateForFile(
	absPath: string,
	target: MarkdownRequestTranslateTarget,
	config: Configuration,
): Promise<RequestTranslateResult> {
	const outcome = await withMarkerOnlyMutation<RequestTranslateResult>(absPath, config, ({ parsed }) => {
		if (target.kind === "frontmatter") {
			const marker = parseFrontmatterMarker(parsed.frontMatter);
			const reason = sendBackToTranslation(marker);
			if (reason || !marker || !parsed.frontMatter) {
				return { requested: false, changed: false, hash: marker?.hash ?? "", reason: reason ?? "not-found" };
			}
			setFrontmatterMarker(parsed.frontMatter, marker);
			return { requested: true, changed: true, hash: marker.hash };
		}

		const unit = parsed.units.find((u) => u.marker?.hash === target.hash);
		const reason = sendBackToTranslation(unit?.marker);
		if (reason || !unit) {
			return { requested: false, changed: false, hash: target.hash, reason: reason ?? "not-found" };
		}
		const result: RequestTranslateResult = { requested: true, changed: true, hash: target.hash };
		if (unit.title) {
			result.title = unit.title;
		}
		return result;
	});

	logger.info("resolve", "Translation requested for reviewed unit", {
		file: absPath,
		target: target.kind,
		hash: outcome.hash,
		requested: outcome.requested,
		reason: outcome.reason,
	});
	return outcome;
}
