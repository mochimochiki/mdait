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
import * as fs from "node:fs";
import type * as vscode from "vscode";
import type { MdaitConflicts } from "../../core/conflict/mdait-conflicts";
import type { Configuration } from "../../infra/config/configuration";
import { Logger, formatError } from "../../infra/logging/logger";
import { TermsRepository } from "../term/terms-repository";
import { ConflictEvidenceProvider } from "./conflict-evidence";
import type { ConflictJudge } from "./conflict-judge";
import {
	type ChoiceSide,
	type ConflictResolutionPlan,
	type ResolutionFailure,
	type ResolutionOutcome,
	type ResolutionPlan,
	isDeletionChoice,
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
	/**
	 * 計画を作った時点のファイルの見た目（更新時刻と寸法）。
	 *
	 * 計画から書き戻しまでのあいだに確認ダイアログと AI への問い合わせが挟まる。その間に
	 * 人が手で直したり同期が走ったりしたら、**古い計画で上書きしてはいけない**。
	 */
	stamps: Map<string, string>;
}

/** ファイルの見た目。読めなければ空文字（無いファイルは書き戻す先でもない） */
function stampOf(filePath: string): string {
	try {
		const stat = fs.statSync(filePath);
		return `${stat.mtimeMs}:${stat.size}`;
	} catch {
		return "";
	}
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
	const stamps = new Map<string, string>();
	const failures: ResolutionFailure[] = [];

	for (const file of conflicts.files) {
		stamps.set(file.filePath, stampOf(file.filePath));
		try {
			switch (file.kind) {
				case "tm": {
					const planned = planTmResolution(file.filePath, config.primaryLang);
					if (planned) {
						plans.push(planned.plan);
						carried.set(file.filePath, { tm: planned.resolution });
					}
					break;
				}
				case "terms": {
					// 競合中のファイルは通常の読み込みでは読めないので、空のリポジトリを作って
					// 解決専用の入口（`loadSide`）から両側を読ませる
					const repository = await TermsRepository.create(
						file.filePath,
						config.transPairs,
						undefined,
						config.primaryLang,
					);
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
			// 1つの対象が読めなくても、残りは解ける。**読めなかったことは必ず持ち帰る** —
			// ここで黙って落とすと、壊れた1ファイルだけが競合していたときに
			// 「未解決の競合はありません」と出る
			logger.warn("conflict", "Failed to plan a resolution", { kind: file.kind, ...formatError(error) });
			failures.push({
				kind: file.kind,
				filePath: file.filePath,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return { summary: summarizePlans(plans, failures, conflicts.heldRows.length), carried, stamps };
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
): Promise<{
	outcomes: ResolutionOutcome[];
	reasons: Map<string, string>;
	/** AI がどちらを採ったか（レポートに出す。理由だけでは採否を確かめられない） */
	sides: Map<string, ChoiceSide>;
}> {
	const outcomes: ResolutionOutcome[] = [];
	const reasons = new Map<string, string>();
	const sides = new Map<string, ChoiceSide>();

	// 判定の材料は、競合していないファイルからだけ集める
	const conflictedKinds = new Set(prepared.summary.plans.map((plan) => plan.kind));
	const evidence = judge ? await ConflictEvidenceProvider.create(config, conflictedKinds) : undefined;

	for (const plan of prepared.summary.plans) {
		if (token?.isCancellationRequested) {
			// **手を付けなかった対象も結果に載せる。** 載せないと、残った件が数に出ず
			// 「全部解決しました」と言ってしまう
			outcomes.push(skippedOutcome(plan));
			continue;
		}
		progress?.report({ message: targetName(plan) });

		let decided: ReadonlyMap<string, ChoiceSide> = new Map();
		// **片方が消した件は AI へ送らない。** AI に許した語彙は二択だけで、「消す」は
		// その外にある（ADR-260912-01）。人が決める
		const askable = plan.pending.filter((item) => !isDeletionChoice(item));
		if (judge && askable.length > 0) {
			const result = await judge.judge(
				askable,
				{
					targetName: targetName(plan),
					responseLang,
					evidenceFor: evidence ? (item) => evidence.forItem(item) : undefined,
				},
				token,
			);
			decided = result.decided;
			for (const [key, reason] of result.reasons) {
				reasons.set(key, reason);
			}
			for (const [key, side] of result.decided) {
				sides.set(key, side);
			}
		}

		outcomes.push(await applyOne(plan, prepared, config, decided));
	}

	return { outcomes, reasons, sides };
}

/** 取り消されて手が付かなかった対象の結果（残っている件はそのまま残っている） */
function skippedOutcome(plan: ResolutionPlan): ResolutionOutcome {
	return {
		kind: plan.kind,
		filePath: plan.filePath,
		autoResolvedCount: 0,
		decidedCount: 0,
		remainingCount: Math.max(plan.pending.length, 1),
		written: false,
		skipped: true,
	};
}

/**
 * 計画を作ってから、そのファイルが外で変わっていないか。
 *
 * 確認ダイアログと AI への問い合わせのあいだに人が手で直したり同期が走ったりしうる。
 * 変わっていたら**書かない** — 手元の計画はもう1つ前の姿を指しているので、書けば相手の
 * 変更をそのまま消す。数え直せば新しい計画が作られる。
 *
 * @returns 変わっていれば理由、変わっていなければ `undefined`
 */
function staleError(plan: ResolutionPlan, prepared: PreparedResolution): string | undefined {
	const planned = prepared.stamps.get(plan.filePath);
	if (planned === undefined || planned === stampOf(plan.filePath)) {
		return undefined;
	}
	return `${plan.filePath} changed while the resolution was being prepared. Nothing was written; run the resolution again.`;
}

/**
 * **人が決めた結果を書き戻す**（roadmap-v04 P03）。AI は1回も呼ばない。
 *
 * `executeResolution` は全対象を回すが、こちらは1つの対象だけを書き戻す — 人はツリーの
 * 行を1件ずつ決めていくので、その対象の最後の1件が決まった時点で呼ばれる。
 */
export async function applyDecidedResolution(
	plan: ResolutionPlan,
	prepared: PreparedResolution,
	config: Configuration,
	decided: ReadonlyMap<string, ChoiceSide>,
): Promise<ResolutionOutcome> {
	return applyOne(plan, prepared, config, decided);
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
				const stale = staleError(plan, prepared);
				if (stale) {
					return { ...base, error: stale };
				}
				const result = applyTmResolution(plan.filePath, plan, carried.tm, decided);
				return { ...base, ...result, written: result.remainingCount === 0 };
			}
			case "terms": {
				if (!carried?.terms || !carried.repository) {
					return base;
				}
				const stale = staleError(plan, prepared);
				if (stale) {
					return { ...base, error: stale };
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
