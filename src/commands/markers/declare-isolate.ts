/**
 * @file declare-isolate.ts
 * @description
 *   ユニットに need:isolate を宣言する（凍結宣言。ADR-260711-05 の isolate モデルに従い、
 *   以後 sync は hash/from のみ更新し revise を流さない＝下流伝播を止める）。
 *   訳文・原文の両方に使える（原文側は sync が need:translate を生成しなくなる。ADR-260706-02）。
 *   解除（undeclare）は resolve-need.ts の need 除去を再利用する。
 *
 *   呼び出し口は `MdFileHandler.declareIsolate` に一本化されている
 *   （サーフェスごとに書き換えを実装しないこと。理由は unit-mutation.ts を参照）。
 * @module commands/markers/declare-isolate
 */
import type { Configuration } from "../../infra/config/configuration";
import { Logger } from "../../infra/logging/logger";
import { type UnitMutationResult, withMarkdownMutation } from "./unit-mutation";

const logger = Logger.getInstance();

export type DeclareIsolateSkipReason = "not-found" | "need-already-set";

export interface DeclareIsolateResult extends UnitMutationResult {
	declared: boolean;
	hash: string;
	title?: string;
	reason?: DeclareIsolateSkipReason;
}

/**
 * 指定ユニットに need:isolate を宣言する。
 * 既に何らかの need が付いている場合はスキップする（宣言操作が他の判断待ちを踏み潰さない安全弁。
 * 先に裁定してから凍結する、という順序を強制する）。
 *
 * @param absPath 対象ファイルの絶対パス
 * @param unitHash 宣言対象ユニットの hash
 * @param config 設定
 */
export async function declareIsolateForFile(
	absPath: string,
	unitHash: string,
	config: Configuration,
): Promise<DeclareIsolateResult> {
	const outcome = await withMarkdownMutation<DeclareIsolateResult>(absPath, config, ({ parsed }) => {
		const unit = parsed.units.find((u) => u.marker?.hash === unitHash);
		if (!unit?.marker) {
			return {
				declared: false,
				changed: false,
				hash: unitHash,
				reason: "not-found",
			};
		}
		if (unit.marker.need) {
			return {
				declared: false,
				changed: false,
				hash: unitHash,
				reason: "need-already-set",
			};
		}

		unit.marker.setNeed("isolate");
		const result: DeclareIsolateResult = {
			declared: true,
			changed: true,
			hash: unitHash,
		};
		if (unit.title) {
			result.title = unit.title;
		}
		return result;
	});

	logger.info("resolve", "Isolate declared", {
		file: absPath,
		hash: unitHash,
		declared: outcome.declared,
	});
	return outcome;
}
