/**
 * @file take-side-command.ts
 * @description
 *   `あなたを残す` / `相手を残す` — **人が1件ずつ決める**（roadmap-v04 P03）。
 *
 *   **決めても書かない。** 決まらない件が残っているうちに書くと、残った件の両側が
 *   ディスクから消えるので、書けるのは全件が決まったあとだけである。そのうえで、
 *   **最後の1件を決めた瞬間に書きに行くこともしない** — 1件を選ぶという小さな操作が
 *   ファイル全体の書き換えを起こすと、結果の大きさが操作と釣り合わず、決め直す機会も
 *   無くなる。全件が決まると、そのファイルの行に `解決` が出る（`resolveDecidedFile`）。
 *   途中の判断は `conflict-decisions.ts` が預かる。
 *
 * @module commands/conflict/take-side-command
 */
import * as vscode from "vscode";
import { Configuration } from "../../infra/config/configuration";
import { Logger, formatError } from "../../infra/logging/logger";
import { choiceOfConflictRow, fingerprintOfKey, filePathOfConflictRow } from "../../ui/status/conflict-branch";
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
 * 1件について「こちら」か「あちら」を採る。**預かるだけで、ファイルは動かない。**
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

	// **ここでは1バイトも書かない。** 書くのは人が `解決` を押したときだけである。
	// 覚え書きも捨てない — 計画は動いていないので、読み直させると用語集と TM を
	// 解き直すだけで何も変わらない（行の数え上げは預かりを引いて出す）
	rememberDecision(target.filePath, stamp, target.key, side);
}

/**
 * そのファイルの決まったぶんを書き戻す（ツリーのファイルの行の `解決`）。
 *
 * 出るのは**全件が決まったあと**だけなので、ここへ来る時点で書けるはずである。それでも
 * 決まっていなければ何も書かない（ファイルが外から変わって計画が作り直されたときに
 * 起こりうる）。
 */
export async function resolveDecidedFile(filePath: string | undefined): Promise<void> {
	if (!filePath) {
		return;
	}
	const config = Configuration.getInstance();
	const prepared = await collectPendingChoices(config);
	const plan = prepared?.summary.plans.find((candidate) => candidate.filePath === filePath);
	const stamp = prepared?.stamps.get(filePath);
	if (!prepared || !plan || stamp === undefined) {
		forgetDecisions(filePath);
		invalidateWorkspaceConflicts();
		return;
	}

	const decided = decisionsFor(filePath, stamp);
	const remaining = plan.pending.filter((item) => !decided.has(item.key)).length;
	if (remaining > 0) {
		// 決まっていない件がある。**押せるはずの無いときに押された** — 数え直させて黙る
		invalidateWorkspaceConflicts();
		return;
	}

	try {
		const outcome = await applyDecidedResolution(plan, prepared, config, decided);
		if (outcome.error) {
			// **書けなかったのに預かりを捨てない。** 捨てると、競合は残ったまま人の
			// 選択だけが消え、何も言われないまま最初からやり直しになる
			throw new Error(outcome.error);
		}
		forgetDecisions(filePath);
		invalidateWorkspaceConflicts();
		if (outcome.written) {
			void vscode.window.showInformationMessage(
				vscode.l10n.t("Resolved every conflict in {0}.", vscode.workspace.asRelativePath(filePath)),
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

/** ツリーのファイルの行から `解決` を受ける */
export async function resolveDecidedFileForItem(item: unknown): Promise<void> {
	const directoryPath = (item as { directoryPath?: string } | undefined)?.directoryPath;
	await resolveDecidedFile(directoryPath ? filePathOfConflictRow(directoryPath) : undefined);
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
