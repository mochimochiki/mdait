/**
 * @file resolve-core.ts
 * @description
 *   競合の解決の本体（roadmap-v04 P02）。VS Code の UI を持たないので、コマンドからも
 *   LM Tool からも同じ道を通れる。
 *
 *   段取りは4つで、**順番に意味がある**。
 *
 *   1. **計画を作る** … 両側を切り出し、鍵で突き合わせる。ここで**1バイトも書かない**
 *   2. **確認をもらう** … 件数と概算を見せてから承認を待つ。AI へ問い合わせるのはこの後
 *      （UX-P4。判定が終わってから確認を出す形にはしない）
 *   3. **判定する** … 決まらない件だけを AI へ。迷った件はそのまま残る
 *   4. **書き戻す** … 対象ごとの解決専用の入口を通る。新しい書き込み経路は作らない
 *
 *   **決まらない件が1つでも残った対象は、1バイトも書かない。** 半端に書き戻すと、
 *   残った件の両側がディスクから消える。その対象は競合マーカーの入ったまま残り、
 *   人が決める（P03）。
 *
 * @module commands/conflict/resolve-core
 */
import type * as vscode from "vscode";
import type { MdaitConflicts } from "../../core/conflict/mdait-conflicts";
import type { Configuration } from "../../infra/config/configuration";
import { Logger, formatError } from "../../infra/logging/logger";
import { TermsRepository } from "../term/terms-repository";
import type { ConflictJudge } from "./conflict-judge";
import {
	type ChoiceSide,
	type ConflictResolutionPlan,
	type ResolutionOutcome,
	type ResolutionPlan,
	summarizePlans,
} from "./resolution-plan";
import {
	applyUnitRegistryResolution,
	applyUnitStateResolution,
	planUnitRegistryResolution,
	planUnitStateResolution,
} from "./targets/state-target";
import { type TermsResolution, applyTermsResolution, planTermsResolution } from "./targets/terms-target";
import { type TmResolution, applyTmResolution, planTmResolution } from "./targets/tm-target";

const logger = Logger.getInstance();

/** 計画と、書き戻しに要る持ち物を一緒に抱えておく */
export interface PreparedResolution {
	summary: ConflictResolutionPlan;
	/** 対象ごとの持ち物（書き戻すときに要る） */
	carried: Map<string, { tm?: TmResolution; terms?: TermsResolution; repository?: TermsRepository }>;
}

/** 対象の人が読む名前（AI にも「何が競合しているか」として渡す） */
function targetName(plan: ResolutionPlan): string {
	switch (plan.kind) {
		case "unit-state":
			return "unit state";
		case "unit-registry":
			return "source snapshots";
		case "tm":
			return "translation memory";
		case "terms":
			return "glossary";
	}
}

/**
 * 競合を読んで計画を作る。**1バイトも書かない。**
 *
 * 確認ダイアログはこの結果から件数を出すので、承認の前に「何件を AI にかけるか」が言える。
 */
export async function prepareResolution(
	conflicts: MdaitConflicts,
	config: Configuration,
): Promise<PreparedResolution> {
	const plans: ResolutionPlan[] = [];
	const carried: PreparedResolution["carried"] = new Map();

	for (const file of conflicts.files) {
		try {
			switch (file.kind) {
				case "tm": {
					const planned = planTmResolution(file.filePath);
					if (planned) {
						plans.push(planned.plan);
						carried.set(file.filePath, { tm: planned.resolution });
					}
					break;
				}
				case "terms": {
					// 競合中のファイルは通常の読み込みでは読めないので、空のリポジトリを作って
					// 解決専用の入口（`loadSide`）から両側を読ませる
					const repository = await TermsRepository.create(file.filePath, config.transPairs);
					const planned = await planTermsResolution(file.filePath, repository, config.primaryLang);
					if (planned) {
						plans.push(planned.plan);
						carried.set(file.filePath, { terms: planned.resolution, repository });
					}
					break;
				}
				case "unit-state":
					plans.push(planUnitStateResolution(file.filePath));
					break;
				case "unit-registry":
					plans.push(planUnitRegistryResolution(file.filePath));
					break;
			}
		} catch (error) {
			// 1つの対象が読めなくても、残りは解ける。読めなかったことはレポートに出す
			logger.warn("conflict", "Failed to plan a resolution", { kind: file.kind, ...formatError(error) });
		}
	}

	return { summary: summarizePlans(plans), carried };
}

/**
 * 計画を実行する。
 *
 * @param judge 判定にかける係。`undefined` なら AI を1回も呼ばず、決まらない件は全部残す
 *   （API キーが無い場合。器だけで全件を人が解決できる — ADR-260911-02）
 */
export async function executeResolution(
	prepared: PreparedResolution,
	config: Configuration,
	judge: ConflictJudge | undefined,
	responseLang: string | undefined,
	progress?: vscode.Progress<{ message?: string; increment?: number }>,
	token?: vscode.CancellationToken,
): Promise<{ outcomes: ResolutionOutcome[]; reasons: Map<string, string> }> {
	const outcomes: ResolutionOutcome[] = [];
	const reasons = new Map<string, string>();

	for (const plan of prepared.summary.plans) {
		if (token?.isCancellationRequested) {
			break;
		}
		progress?.report({ message: targetName(plan) });

		let decided: ReadonlyMap<string, ChoiceSide> = new Map();
		if (judge && plan.pending.length > 0) {
			const result = await judge.judge(plan.pending, { targetName: targetName(plan), responseLang }, token);
			decided = result.decided;
			for (const [key, reason] of result.reasons) {
				reasons.set(key, reason);
			}
		}

		outcomes.push(await applyOne(plan, prepared, config, decided));
	}

	return { outcomes, reasons };
}

/** 1つの対象を書き戻す */
async function applyOne(
	plan: ResolutionPlan,
	prepared: PreparedResolution,
	config: Configuration,
	decided: ReadonlyMap<string, ChoiceSide>,
): Promise<ResolutionOutcome> {
	const carried = prepared.carried.get(plan.filePath);
	const base: ResolutionOutcome = {
		kind: plan.kind,
		filePath: plan.filePath,
		autoResolvedCount: plan.autoResolvedCount,
		decidedCount: 0,
		remainingCount: plan.pending.length,
		written: false,
	};

	try {
		switch (plan.kind) {
			case "tm": {
				if (!carried?.tm) {
					return base;
				}
				const result = applyTmResolution(plan.filePath, plan, carried.tm, decided);
				return { ...base, ...result, written: result.remainingCount === 0 };
			}
			case "terms": {
				if (!carried?.terms || !carried.repository) {
					return base;
				}
				const result = await applyTermsResolution(plan, carried.terms, carried.repository, decided);
				return { ...base, ...result, written: result.remainingCount === 0 };
			}
			case "unit-state": {
				const result = await applyUnitStateResolution(config.getMdaitDir());
				return {
					...base,
					autoResolvedCount: result.rows,
					remainingCount: 0,
					written: true,
					// 降ろされた行は残るが、**解けていないのではない**（行はどちらも残っている）。
					// どちらを席へ戻すかを原稿と突き合わせて決めるのは P03 の仕事である
					unseatedCount: result.unseated,
				};
			}
			case "unit-registry": {
				const rows = await applyUnitRegistryResolution();
				return { ...base, autoResolvedCount: rows, remainingCount: 0, written: true };
			}
		}
	} catch (error) {
		logger.warn("conflict", "Failed to write a resolution", { kind: plan.kind, ...formatError(error) });
		return { ...base, error: error instanceof Error ? error.message : String(error) };
	}
}
