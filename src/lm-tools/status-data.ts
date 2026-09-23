/**
 * @file status-data.ts
 * @description
 *   StatusItemTree の情報を LM Tools のエンベロープ `data` 向けに集計する純関数群。
 *   need フラグの語彙（translate/revise/review/verify-deletion/isolate）ごとの
 *   内訳集計と、ファイル別内訳の生成を行う。VS Code API 非依存。
 * @module lm-tools/status-data
 */
import type { ConflictFileKind, MdaitConflicts } from "../core/conflict/mdait-conflicts";
import type { FileStatusItem, UnitStatusItem } from "../core/status/status-item";
import { Status, isCountedInProgress, isIsolatedNeed } from "../core/status/status-item";

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

/** detail 出力に含めるユニット別 need 情報（need のあるユニットのみ列挙する） */
export interface UnitNeedDetail {
	/** マーカーのユニット hash */
	hash: string;
	/** ユニットの見出しタイトル */
	title?: string;
	/** need フラグの生値（translate / revise@{hash} / review / verify-deletion / isolate / ...） */
	need: string;
}

/** 1ファイルあたりの units 列挙上限（出力肥大防止） */
export const MAX_UNIT_DETAILS_PER_FILE = 50;

/** ファイル別のステータス内訳 */
export interface FileNeedDetail {
	path: string;
	totalUnits: number;
	translatedUnits: number;
	needs: NeedBreakdown;
	/** need のあるユニット一覧（isolate 含む。上限 MAX_UNIT_DETAILS_PER_FILE 件） */
	units: UnitNeedDetail[];
	/** units が上限で切り詰められたとき true */
	unitsTruncated?: boolean;
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
	/**
	 * 原文と結びついていない訳文のパス一覧（ADR-260806-01）。
	 *
	 * 人のツリーに出ている状態をエージェントにも同じだけ見せる（片方にしか出ない状態を作らない）。
	 * **破棄の手段は渡さない** — 「この訳文はもう要らない」は機械が決めることではないため、
	 * エージェントにできるのは原文を戻すか、人に判断を求めることだけである。
	 */
	orphanTargets: string[];
	/**
	 * `.mdait` に残っている合流の競合（roadmap-v04）。**選択中の言語ペアやパスで絞らない** —
	 * `.mdait` のファイルはワークスペースに1つずつで、どの範囲を聞かれても同じ答えになる。
	 *
	 * 人のステータスバーとツリーに出ている件数をエージェントにも同じだけ見せる。競合が残って
	 * いるあいだは用語集と翻訳メモリが読めず、翻訳の材料が欠ける。**解決の手段は渡さない** —
	 * 同じ鍵に別の値が来た件を選ぶのは人の仕事で（ux.md §3.3）、エージェントにできるのは
	 * 人に解決を頼むことだけである。
	 */
	conflicts: ConflictData;
}

/** エージェントに見せる競合の内訳 */
export interface ConflictData {
	/** 人が片付ける件数（ファイル1つで1件、合流で席から降ろされた行1つで1件） */
	total: number;
	/** 競合マーカーの残っているファイル（パスはワークスペース相対） */
	files: Array<{ kind: ConflictFileKind; path: string }>;
	/** 合流で席から降ろされた `unit-state` の行の数 */
	mergeHeldRows: number;
}

/**
 * 競合の数え上げを、エージェント向けの形へ写す。
 * @param toRelative 絶対パスをワークスペース相対へ直す関数
 */
export function buildConflictData(conflicts: MdaitConflicts, toRelative: (filePath: string) => string): ConflictData {
	return {
		total: conflicts.total,
		files: conflicts.files.map((file) => ({ kind: file.kind, path: toRelative(file.filePath) })),
		mergeHeldRows: conflicts.heldRows.length,
	};
}

/** 競合が1件も無いときの内訳 */
export function emptyConflictData(): ConflictData {
	return { total: 0, files: [], mergeHeldRows: 0 };
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
 * need フラグ文字列の一覧から内訳を集計する。
 * ステータスによるフィルタは行わない（呼び出し側が対象を選別する）。
 */
export function countNeedFlags(needFlags: string[]): NeedBreakdown {
	const breakdown = emptyBreakdown();
	for (const flag of needFlags) {
		addNeedFlag(breakdown, flag);
	}
	return breakdown;
}

/**
 * ユニット一覧から need 内訳を集計する。
 * 原文ユニット（Status.Source）は集計対象外。凍結ユニットは進捗の分母には入らないが
 * 内訳には計上する（`isolate` が何件あるかはエージェントに見えている必要があるため）。
 */
export function countNeeds(units: UnitStatusItem[]): NeedBreakdown {
	const breakdown = emptyBreakdown();
	for (const unit of units) {
		// 凍結宣言は原文側にも行える（ADR-260706-02）。原文ユニットは進捗集計の対象外だが、
		// 「どこを凍結したか」はエージェントが解除を判断するために見えている必要があるので、
		// 原文側かどうかに関わらず内訳へ計上する
		if (unit.status === Status.Source && !isIsolatedNeed(unit.needFlag)) {
			continue;
		}
		if (unit.needFlag) {
			addNeedFlag(breakdown, unit.needFlag);
		}
	}
	return breakdown;
}

/**
 * need のあるユニットのみを UnitNeedDetail として列挙する。
 * countNeeds と同じ基準で対象を選ぶ（原文ユニットは除外。ただし凍結宣言は原文側も列挙する）。
 * 上限 MAX_UNIT_DETAILS_PER_FILE 件で切り詰め、超過時は truncated を返す。
 */
function buildUnitNeedDetails(units: UnitStatusItem[]): {
	units: UnitNeedDetail[];
	truncated: boolean;
} {
	const details: UnitNeedDetail[] = [];
	let truncated = false;
	for (const unit of units) {
		if (!unit.needFlag) {
			continue;
		}
		// countNeeds と同じ基準（原文側の凍結ユニットも列挙する）
		if (unit.status === Status.Source && !isIsolatedNeed(unit.needFlag)) {
			continue;
		}
		if (details.length >= MAX_UNIT_DETAILS_PER_FILE) {
			truncated = true;
			break;
		}
		const detail: UnitNeedDetail = { hash: unit.unitHash, need: unit.needFlag };
		if (unit.title) {
			detail.title = unit.title;
		}
		details.push(detail);
	}
	return { units: details, truncated };
}

/**
 * ターゲットファイル一覧から全体ステータスデータを構築する。
 * @param files 対象ファイル（ソースファイルは内部で除外する）
 * @param detail true のとき need のあるファイルの内訳一覧を含める
 * @param conflicts `.mdait` に残っている競合（省略すると 0 件）
 */
export function buildStatusData(
	files: FileStatusItem[],
	detail: boolean,
	conflicts: ConflictData = emptyConflictData(),
): StatusData {
	const totals = emptyBreakdown();
	let totalUnits = 0;
	let translatedUnits = 0;
	let errorUnits = 0;
	let filesWithNeeds = 0;
	let filesTranslated = 0;
	const fileDetails: FileNeedDetail[] = [];
	const orphanTargets: string[] = [];

	for (const file of files) {
		const units = file.children ?? [];
		const needs = countNeeds(units);
		if (file.status === Status.Source) {
			// ソースファイルは進捗集計の対象外
			continue;
		}
		if (file.isOrphanTarget) {
			orphanTargets.push(file.filePath);
		}
		for (const unit of units) {
			if (!isCountedInProgress(unit)) {
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
				// 全体集計と同じ基準（原文側と凍結ユニットは分母から除外）
				const countableUnits = units.filter(isCountedInProgress);
				const unitDetails = buildUnitNeedDetails(units);
				const fileDetail: FileNeedDetail = {
					path: file.filePath,
					totalUnits: countableUnits.length,
					translatedUnits: countableUnits.filter((u) => u.status === Status.Translated).length,
					needs,
					units: unitDetails.units,
				};
				if (unitDetails.truncated) {
					fileDetail.unitsTruncated = true;
				}
				fileDetails.push(fileDetail);
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
		orphanTargets,
		conflicts,
	};
	if (detail) {
		data.files = fileDetails;
	}
	return data;
}
