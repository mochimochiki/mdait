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
import { calculateHash } from "../../core/hash/hash-calculator";
import type { MdaitUnit } from "../../core/markdown/mdait-unit";
import type { Configuration } from "../../infra/config/configuration";
import { Logger } from "../../infra/logging/logger";
import { type UnitMutationResult, withMarkerOnlyMutation } from "./unit-mutation";

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
	const outcome = await withMarkerOnlyMutation<KeepUnitsResult>(absPath, config, ({ parsed }) => {
		const kept: KeptUnit[] = [];
		const skipped: SkippedKeepUnit[] = [];

		/**
		 * 独立化の実体。sync の独立ユニット保護は「hash あり・from なし」が条件なので、
		 * hash の無い手書きマーカーはここで hash を合成してから外す（合成しないと
		 * 「以後対応付けない」と伝えたのに次の sync で need:review の列へ戻る）。
		 */
		const keepOne = (unit: MdaitUnit): string => {
			const marker = unit.marker;
			if (!marker) {
				return "";
			}
			if (!marker.hash) {
				marker.updateHash(calculateHash(unit.content));
			}
			marker.removeNeedTag();
			marker.from = null;
			kept.push(unit.title ? { hash: marker.hash, title: unit.title } : { hash: marker.hash });
			return marker.hash;
		};

		if (hashes && hashes.length > 0) {
			for (const hash of hashes) {
				// hash は本文 CRC なので同一本文の章が並ぶと重複する。先頭一致だけだと
				// 「Keep 済みの1つ目」を掴み続けて2つ目に永久に到達できないため、
				// verify-deletion が付いているものを優先して探す
				const unit =
					parsed.units.find((u) => u.marker?.hash === hash && u.marker.need === "verify-deletion") ??
					parsed.units.find((u) => u.marker?.hash === hash);
				if (!unit?.marker) {
					skipped.push({ hash, reason: "not-found" });
					continue;
				}
				if (unit.marker.need !== "verify-deletion") {
					skipped.push({ hash, reason: "not-verify-deletion" });
					continue;
				}
				keepOne(unit);
			}
		} else {
			for (const unit of parsed.units) {
				if (unit.marker?.need !== "verify-deletion") {
					continue;
				}
				keepOne(unit);
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
