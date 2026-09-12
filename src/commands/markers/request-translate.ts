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
 *   呼び出し口は `MdFileHandler.requestTranslate` に一本化されている
 *   （サーフェスごとに書き換えを実装しないこと。理由は unit-mutation.ts を参照）。
 * @module commands/markers/request-translate
 */
import type { Configuration } from "../../infra/config/configuration";
import { Logger } from "../../infra/logging/logger";
import { type UnitMutationResult, withMarkerOnlyMutation } from "./unit-mutation";

const logger = Logger.getInstance();

/**
 * スキップの理由。
 * - `not-found`: その hash のユニットが無い
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

/**
 * 指定ユニットの need:review を need:translate に付け替える。
 * need が review 以外のユニットは変更せず、理由つきでスキップする。
 *
 * @param absPath 対象ファイルの絶対パス
 * @param unitHash 対象ユニットの hash
 * @param config 設定
 */
export async function requestTranslateForFile(
	absPath: string,
	unitHash: string,
	config: Configuration,
): Promise<RequestTranslateResult> {
	const outcome = await withMarkerOnlyMutation<RequestTranslateResult>(absPath, config, ({ parsed }) => {
		const unit = parsed.units.find((u) => u.marker?.hash === unitHash);
		if (!unit?.marker) {
			return { requested: false, changed: false, hash: unitHash, reason: "not-found" };
		}
		if (unit.marker.need !== "review") {
			return { requested: false, changed: false, hash: unitHash, reason: "not-review" };
		}

		unit.marker.setNeed("translate");
		const result: RequestTranslateResult = { requested: true, changed: true, hash: unitHash };
		if (unit.title) {
			result.title = unit.title;
		}
		return result;
	});

	logger.info("resolve", "Translation requested for reviewed unit", {
		file: absPath,
		hash: unitHash,
		requested: outcome.requested,
		reason: outcome.reason,
	});
	return outcome;
}
