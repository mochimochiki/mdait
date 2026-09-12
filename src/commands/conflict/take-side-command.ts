/**
 * @file take-side-command.ts
 * @description
 *   `あなたを残す` / `相手を残す` — **人が1件ずつ決める**（roadmap-v04 P03）。
 *
 *   決めたぶんはその場では書かない。**そのファイルの最後の1件が決まったときに、まとめて
 *   書き戻す。** 決まらない件が残っているうちに書くと、残った件の両側がディスクから
 *   消えるからである。途中の判断は `conflict-decisions.ts` が預かる。
 *
 * @module commands/conflict/take-side-command
 */
import * as vscode from "vscode";
import { Configuration } from "../../infra/config/configuration";
import { Logger, formatError } from "../../infra/logging/logger";
import { choiceOfConflictRow, fingerprintOfKey } from "../../ui/status/conflict-branch";
import { collectPendingChoices, invalidateWorkspaceConflicts } from "../../ui/status/conflict-source";
import { decisionsFor, forgetDecisions, rememberDecision } from "./conflict-decisions";
import type { ChoiceSide } from "./resolution-plan";
import { applyDecidedResolution } from "./resolve-core";

const logger = Logger.getInstance();

/** ツリーの行がコマンドへ渡す、1件を指すもの */
export interface TakeSideTarget {
	/** 対象のファイル（絶対パス） */
	filePath: string;
	/** その中の1件を指す鍵 */
	key: string;
}

/**
 * 1件について「こちら」か「あちら」を採る。
 *
 * そのファイルの件が全部決まったら、その場で書き戻す。まだ残っていれば預かるだけで、
 * ファイルは競合マーカーの入ったまま動かない。
 */
export async function takeSide(target: TakeSideTarget | undefined, side: ChoiceSide): Promise<void> {
	if (!target?.filePath || !target.key) {
		return;
	}
	const config = Configuration.getInstance();

	const prepared = await collectPendingChoices(config);
	const plan = prepared?.summary.plans.find((candidate) => candidate.filePath === target.filePath);
	const stamp = prepared?.stamps.get(target.filePath);
	if (!prepared || !plan || stamp === undefined) {
		// 計画が引けない（ファイルが外から変わった）。預かりは捨てて数え直させる
		forgetDecisions(target.filePath);
		invalidateWorkspaceConflicts();
		return;
	}

	rememberDecision(target.filePath, stamp, target.key, side);

	const decided = decisionsFor(target.filePath, stamp);
	const remaining = plan.pending.filter((item) => !decided.has(item.key)).length;
	if (remaining > 0) {
		// まだ決まらない件がある。**ここでは1バイトも書かない**
		return;
	}

	try {
		const outcome = await applyDecidedResolution(plan, prepared, config, decided);
		if (outcome.error) {
			// **書けなかったのに預かりを捨てない。** 捨てると、競合は残ったまま人の
			// 選択だけが消え、何も言われないまま最初からやり直しになる
			throw new Error(outcome.error);
		}
		forgetDecisions(target.filePath);
		invalidateWorkspaceConflicts();
		if (outcome.written) {
			void vscode.window.showInformationMessage(
				vscode.l10n.t("Resolved every conflict in {0}.", vscode.workspace.asRelativePath(target.filePath)),
			);
		}
	} catch (error) {
		invalidateWorkspaceConflicts();
		logger.warn("conflict", "Failed to write a hand-made resolution", formatError(error));
		void vscode.window.showErrorMessage(
			vscode.l10n.t("Could not write the resolution: {0}", error instanceof Error ? error.message : String(error)),
		);
	}
}

/**
 * ツリーの行から `あなたを残す` / `相手を残す` を受ける。
 *
 * 行が持っているのは「どのファイルの何番目か」と鍵の短い目印だけなので、計画を引き直して
 * 鍵へ戻す。番号で持つのは、鍵が長く（席のキーやハッシュ）ツリーの識別子に載せると
 * 読めなくなるためである。**目印は必ず突き合わせる** — ツリーに出したままファイルが外から
 * 変わると、同じ番号が別の件を指しうる。
 */
export async function takeSideForItem(item: unknown, side: ChoiceSide): Promise<void> {
	const directoryPath = (item as { directoryPath?: string } | undefined)?.directoryPath;
	if (!directoryPath) {
		return;
	}
	const row = choiceOfConflictRow(directoryPath);
	if (!row) {
		return;
	}
	const prepared = await collectPendingChoices(Configuration.getInstance());
	const plan = prepared?.summary.plans.find((candidate) => candidate.filePath === row.filePath);
	const choice = plan?.pending[row.index];
	if (!choice || fingerprintOfKey(choice.key) !== row.fingerprint) {
		// ファイルが外から変わって、番号が別の件を指すようになった。**番号だけで当てない** —
		// 押した行が指していた件と違うものを決めてしまう
		invalidateWorkspaceConflicts();
		return;
	}
	await takeSide({ filePath: row.filePath, key: choice.key }, side);
}
