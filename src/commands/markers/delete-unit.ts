/**
 * @file delete-unit.ts
 * @description
 *   verify-deletion 判定で「削除」を選んだユニットをドキュメントから除去する。
 *   hash/from の書き換えに留まる resolve-need.ts と異なり、ユニット（本文＋マーカー）自体を取り除く。
 *   embedded では本文から該当セクションが消え、external では unit-state ストアの行も整合させる
 *   （detachMarkers は「ユニット数が急に減った回は刈らない」安全弁を持つので、人が明示的に頼んだ
 *   削除であることを `MarkerFileContext.deliberateDeletion` で伝える。伝えないと消したはずの行が
 *   席へ預けられて残る）。
 *   安全弁として need:verify-deletion のユニットのみを対象とする（任意ユニットの誤削除を防ぐ）。
 *
 *   呼び出し口は `MdFileHandler.deleteUnit` に一本化されている
 *   （サーフェスごとに書き換えを実装しないこと。理由は unit-mutation.ts を参照）。
 * @module commands/markers/delete-unit
 */
import type { Configuration } from "../../infra/config/configuration";
import { Logger } from "../../infra/logging/logger";
import { type UnitMutationResult, withMarkdownMutation } from "./unit-mutation";

const logger = Logger.getInstance();

export type DeleteUnitSkipReason = "not-found" | "not-verify-deletion";

export interface DeleteUnitResult extends UnitMutationResult {
	deleted: boolean;
	hash: string;
	title?: string;
	reason?: DeleteUnitSkipReason;
}

/** 一括削除されたユニット */
export interface DeletedUnit {
	hash: string;
	title?: string;
}

export interface DeleteUnitsResult extends UnitMutationResult {
	deleted: DeletedUnit[];
}

/**
 * 指定ユニットをファイルから削除する。need:verify-deletion のユニットのみ対象。
 *
 * @param absPath 対象ファイルの絶対パス
 * @param unitHash 削除対象ユニットの hash
 * @param config 設定
 */
export async function deleteUnitFromFile(
	absPath: string,
	unitHash: string,
	config: Configuration,
): Promise<DeleteUnitResult> {
	const outcome = await withMarkdownMutation<DeleteUnitResult>(absPath, config, ({ parsed, io }) => {
		const index = parsed.units.findIndex((u) => u.marker?.hash === unitHash);
		if (index === -1) {
			return {
				deleted: false,
				changed: false,
				hash: unitHash,
				reason: "not-found",
			};
		}
		const target = parsed.units[index];
		if (target.marker?.need !== "verify-deletion") {
			return {
				deleted: false,
				changed: false,
				hash: unitHash,
				reason: "not-verify-deletion",
			};
		}

		const title = target.title;
		parsed.units.splice(index, 1);

		// external: detachMarkers の刈り取りは、ユニット数が急に減った回は働かない
		// （コードブロックの閉じ忘れなどで誤って全行を失わないため）。ここは
		// 「最後の1ユニットを消した」場合も含めて意図的な削除なので、そう伝える。
		if (io.ctx) {
			io.ctx.deliberateDeletion = true;
		}

		const result: DeleteUnitResult = {
			deleted: true,
			changed: true,
			hash: unitHash,
		};
		if (title) {
			result.title = title;
		}
		return result;
	});

	logger.info("resolve", "Unit deleted", {
		file: absPath,
		hash: unitHash,
		deleted: outcome.deleted,
	});
	return outcome;
}

/**
 * ファイル内の need:verify-deletion ユニットを1回の排他で削除する（一括確定）。
 *
 * 1ユニットずつ deleteUnitFromFile を繰り返すとロックの取得・ファイル書き込み・
 * ステータス更新がユニット数ぶん走るため、一括の入口を分ける。
 * 対象の絞り込みは need:verify-deletion のみ（単体削除と同じ安全弁）。
 *
 * @param absPath 対象ファイルの絶対パス
 * @param config 設定
 * @param hashes 対象を確認画面に列挙した集合へ限定する。省略時はファイル内の全 verify-deletion。
 *   確認 modal を見せている間に sync が新しい確認待ちを増やしても、同意していないユニットを
 *   巻き込まないために使う（一致しない指定は黙って残る＝安全側）
 */
export async function deleteAllVerifyDeletionUnits(
	absPath: string,
	config: Configuration,
	hashes?: string[],
): Promise<DeleteUnitsResult> {
	const targetHashes = hashes && hashes.length > 0 ? new Set(hashes) : undefined;
	const outcome = await withMarkdownMutation<DeleteUnitsResult>(absPath, config, ({ parsed, io }) => {
		const deleted: DeletedUnit[] = [];
		for (let i = parsed.units.length - 1; i >= 0; i--) {
			const unit = parsed.units[i];
			if (unit.marker?.need !== "verify-deletion") {
				continue;
			}
			if (targetHashes && !targetHashes.has(unit.marker.hash)) {
				continue;
			}
			const entry: DeletedUnit = { hash: unit.marker.hash };
			if (unit.title) {
				entry.title = unit.title;
			}
			deleted.push(entry);
			parsed.units.splice(i, 1);
		}
		// 末尾から走査したので、結果は文書順に戻して返す
		deleted.reverse();

		if (deleted.length === 0) {
			return { deleted, changed: false };
		}

		// external: 単体削除と同じく、意図的な削除なので「最後の1ユニットを消した」場合も含めて刈る
		if (io.ctx) {
			io.ctx.deliberateDeletion = true;
		}
		return { deleted, changed: true };
	});

	logger.info("resolve", "Verify-deletion units deleted in bulk", {
		file: absPath,
		deleted: outcome.deleted.length,
	});
	return outcome;
}
