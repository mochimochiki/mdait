/**
 * @file status-data.ts
 * @description
 *   StatusItemTree の情報を LM Tools のエンベロープ `data` 向けに集計する純関数群。
 *   need フラグの語彙（translate/revise/review/verify-deletion/keep/backfill）ごとの
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
	keep: number;
	backfill: number;
	other: number;
}

/** need内訳の合計（keepを除く実作業対象数） */
export function totalActionableNeeds(needs: NeedBreakdown): number {
	return needs.translate + needs.revise + needs.review + needs.verifyDeletion + needs.backfill + needs.other;
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
		keep: 0,
		backfill: 0,
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
	} else if (needFlag === "keep") {
		breakdown.keep++;
	} else if (needFlag === "backfill") {
		breakdown.backfill++;
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
		if (file.status === Status.Source) {
			continue;
		}
		const units = file.children ?? [];
		const needs = countNeeds(units);
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
		totals.keep += needs.keep;
		totals.backfill += needs.backfill;
		totals.other += needs.other;

		if (totalActionableNeeds(needs) > 0) {
			filesWithNeeds++;
			if (detail) {
				fileDetails.push({
					path: file.filePath,
					totalUnits: units.length,
					translatedUnits: units.filter((u) => u.status === Status.Translated).length,
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
