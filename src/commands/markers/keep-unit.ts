/**
 * @file keep-unit.ts
 * @description
 *   verify-deletion 判定で「残す」を選んだユニットを独立ユニットにする（Keep の恒久化）。
 *
 *   need を外すだけでは `from` が残るため、次の sync が「原文を失った訳文」として再び拾い、
 *   確認待ちが復活する（unit-state.md §14(6)-(a)）。「訳文を資料として残す」という判断を
 *   恒久化するには need と from を同時に外し、独立ユニット（sync のパススルー保護対象。
 *   sync-command.ts の independentTargets 判定）にする必要がある。この2つを別々に外せる
 *   経路を作ると「from なし need:verify-deletion」というレガシー形（delete ポリシーで
 *   削除される）を再生産するため、必ずこのモジュールを通ること。
 *
 *   安全弁として need:verify-deletion のユニットのみを対象とする。
 *   呼び出し口は `MdFileHandler.keepUnits` に一本化されている
 *   （サーフェスごとに書き換えを実装しないこと。理由は unit-mutation.ts を参照）。
 * @module commands/markers/keep-unit
 */
import { Logger } from "../../infra/logging/logger";
import type { Configuration } from "../../infra/config/configuration";
import { type UnitMutationResult, withMarkdownMutation } from "./unit-mutation";

const logger = Logger.getInstance();

/** Keep（独立化）されたユニット */
export interface KeptUnit {
	hash: string;
	title?: string;
}

export type KeepUnitSkipReason = "not-found" | "not-verify-deletion";

/** hash 指定でスキップされたユニット */
export interface SkippedKeepUnit {
	hash: string;
	reason: KeepUnitSkipReason;
}

export interface KeepUnitsResult extends UnitMutationResult {
	kept: KeptUnit[];
	skipped: SkippedKeepUnit[];
}

/**
 * verify-deletion のユニットを独立ユニットとして残す（need と from を同時に外す）。
 *
 * @param absPath 対象ファイルの絶対パス
 * @param config 設定
 * @param hashes 対象ユニットの hash。省略時はファイル内の全 need:verify-deletion ユニット
 */
export async function keepUnitsAsIndependent(
	absPath: string,
	config: Configuration,
	hashes?: string[],
): Promise<KeepUnitsResult> {
	const outcome = await withMarkdownMutation<KeepUnitsResult>(absPath, config, ({ parsed }) => {
		const kept: KeptUnit[] = [];
		const skipped: SkippedKeepUnit[] = [];

		if (hashes && hashes.length > 0) {
			for (const hash of hashes) {
				const unit = parsed.units.find((u) => u.marker?.hash === hash);
				if (!unit?.marker) {
					skipped.push({ hash, reason: "not-found" });
					continue;
				}
				if (unit.marker.need !== "verify-deletion") {
					skipped.push({ hash, reason: "not-verify-deletion" });
					continue;
				}
				unit.marker.removeNeedTag();
				unit.marker.from = null;
				kept.push(unit.title ? { hash, title: unit.title } : { hash });
			}
		} else {
			for (const unit of parsed.units) {
				if (unit.marker?.need !== "verify-deletion") {
					continue;
				}
				const hash = unit.marker.hash;
				unit.marker.removeNeedTag();
				unit.marker.from = null;
				kept.push(unit.title ? { hash, title: unit.title } : { hash });
			}
		}

		return { kept, skipped, changed: kept.length > 0 };
	});

	logger.info("resolve", "Units kept as independent", {
		file: absPath,
		kept: outcome.kept.length,
		skipped: outcome.skipped.length,
	});
	return outcome;
}
