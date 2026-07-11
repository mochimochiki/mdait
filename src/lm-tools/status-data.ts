/**
 * @file status-data.ts
 * @description
 *   StatusItemTree の情報を LM Tools のエンベロープ `data` 向けに集計する純関数群。
 *   need フラグの語彙（translate/revise/review/verify-deletion/isolate）ごとの
 *   内訳集計と、ファイル別内訳の生成を行う。VS Code API 非依存。
 * @module lm-tools/status-data
 */
import type { FileStatusItem, UnitStatusItem } from "../core/status/status-item";
import { Status } from "../core/status/status-item";

/** need フラグ語彙ごとの件数内訳 */
export interface NeedBreakdown {
	translate: number;
	revise: number;
	review: number;
	verifyDeletion: number;
	isolate: number;
	other: number;
}

/** need内訳の合計（isolateを除く実作業対象数。isolateは定常状態） */
export function totalActionableNeeds(needs: NeedBreakdown): number {
	return needs.translate + needs.revise + needs.review + needs.verifyDeletion + needs.other;
}

/** ファイル別のステータス内訳 */
export interface FileNeedDetail {
	path: string;
	totalUnits: number;
	translatedUnits: number;
	needs: NeedBreakdown;
}

/** 全体ステータスの構造化データ */
export interface StatusData {
	totalUnits: number;
	translatedUnits: number;
	errorUnits: number;
	needs: NeedBreakdown;
	/** need のあるターゲットファイル数 */
	filesWithNeeds: number;
	/** need のないターゲットファイル数（完訳） */
	filesTranslated: number;
	/** detail:true のときのみ。need のあるファイルの内訳（出力爆発防止のため完訳ファイルは含めない） */
	files?: FileNeedDetail[];
}

function emptyBreakdown(): NeedBreakdown {
	return {
		translate: 0,
		revise: 0,
		review: 0,
		verifyDeletion: 0,
		isolate: 0,
		other: 0,
	};
}

/**
 * needフラグ文字列を内訳カテゴリへ分類して加算する
 */
function addNeedFlag(breakdown: NeedBreakdown, needFlag: string): void {
	if (needFlag === "translate") {
		breakdown.translate++;
	} else if (needFlag.startsWith("revise")) {
		breakdown.revise++;
	} else if (needFlag === "review") {
		breakdown.review++;
	} else if (needFlag === "verify-deletion") {
		breakdown.verifyDeletion++;
	} else if (needFlag === "isolate") {
		breakdown.isolate++;
	} else {
		breakdown.other++;
	}
}

/**
 * ユニット一覧から need 内訳を集計する。
 * ソースユニット（Status.Source）は集計対象外。
 */
export function countNeeds(units: UnitStatusItem[]): NeedBreakdown {
	const breakdown = emptyBreakdown();
	for (const unit of units) {
		// need:isolate の孤立ユニットはステータス上ソース扱い（分母除外）だが、内訳には計上する
		if (unit.needFlag === "isolate") {
			breakdown.isolate++;
			continue;
		}
		if (unit.status === Status.Source) {
			continue;
		}
		if (unit.needFlag) {
			addNeedFlag(breakdown, unit.needFlag);
		}
	}
	return breakdown;
}

/**
 * ターゲットファイル一覧から全体ステータスデータを構築する。
 * @param files 対象ファイル（ソースファイルは内部で除外する）
 * @param detail true のとき need のあるファイルの内訳一覧を含める
 */
export function buildStatusData(files: FileStatusItem[], detail: boolean): StatusData {
	const totals = emptyBreakdown();
	let totalUnits = 0;
	let translatedUnits = 0;
	let errorUnits = 0;
	let filesWithNeeds = 0;
	let filesTranslated = 0;
	const fileDetails: FileNeedDetail[] = [];

	for (const file of files) {
		const units = file.children ?? [];
		const needs = countNeeds(units);
		if (file.status === Status.Source) {
			// ソースファイルは進捗集計の対象外
			continue;
		}
		for (const unit of units) {
			if (unit.status === Status.Source) {
				continue;
			}
			totalUnits++;
			if (unit.status === Status.Translated) {
				translatedUnits++;
			} else if (unit.status === Status.Error) {
				errorUnits++;
			}
		}
		totals.translate += needs.translate;
		totals.revise += needs.revise;
		totals.review += needs.review;
		totals.verifyDeletion += needs.verifyDeletion;
		totals.isolate += needs.isolate;
		totals.other += needs.other;

		if (totalActionableNeeds(needs) > 0) {
			filesWithNeeds++;
			if (detail) {
				// 全体集計と同じ基準（Status.Sourceは分母から除外。isolateもSource扱い）
				const countableUnits = units.filter((u) => u.status !== Status.Source);
				fileDetails.push({
					path: file.filePath,
					totalUnits: countableUnits.length,
					translatedUnits: countableUnits.filter((u) => u.status === Status.Translated).length,
					needs,
				});
			}
		} else {
			filesTranslated++;
		}
	}

	const data: StatusData = {
		totalUnits,
		translatedUnits,
		errorUnits,
		needs: totals,
		filesWithNeeds,
		filesTranslated,
	};
	if (detail) {
		data.files = fileDetails;
	}
	return data;
}
