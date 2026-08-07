/**
 * @file rename-follow.ts
 * @description
 *   ファイルの移動（リネーム・フォルダ移動）に、対になる相手と `unit-state` の行を追随させる。
 *
 *   ## なぜ確認を挟まないか
 *
 *   訳文を連れて動かす編集は `onWillRenameFiles` の `waitUntil` へ返す。VS Code は
 *   これをユーザーの移動と**同じ取り消し単位**に入れるので、Ctrl+Z で原文と訳文が
 *   一緒に戻る。この製品は確認の要否を「破壊的か」ではなく「間違えたとき取り返しが
 *   つくか」で決めており（ADR-260804-01 / -260805-01）、取り消しに相乗りできる操作は
 *   確認の要らない側に入る。加えてフォルダの移動はイベント1件でファイルが何十件も
 *   動くため、確認を挟む設計はそもそも成立しない。
 *
 *   ## なぜ入口が2つあるか
 *
 *   ファイルを動かすのは移動の**前**（`waitUntil`）でなければ取り消し単位に入らないが、
 *   `unit-state` の行を付け替えてよいのは移動が**成功したあと**である。移動前に行を
 *   動かすと、ユーザーが移動をやめた（あるいは失敗した）ときに、実体は旧パスにあるのに
 *   行だけ新パスを指す状態が残り、次の sync で行が掃除されて状態を失う。
 *
 *   後半で立てる計画は前半の控えではなく、そのときのディスクの実測である
 *   （`planEntryMoves`）。取り消しはこちらが足した訳文の移動もまとめて巻き戻すが、
 *   そのときエディタが何を報せてくるかは保証されていない。実測なら報せの中身に
 *   関わらず、実際に動いたものにだけ行が付いていく。
 *
 * @module commands/markers/rename-follow
 */
import * as vscode from "vscode";
import { type PathRename, planEntryMoves, planRenameFollow } from "../../core/unit-state/rename-plan";
import { Configuration } from "../../infra/config/configuration";
import { Logger } from "../../infra/logging/logger";
import { createRenameFollowProbe } from "../../infra/workspace/rename-probe";
import { relocateUnitEntries } from "./unit-mutation";

const logger = Logger.getInstance();

/** 移動の一式（`onWillRenameFiles` と `onDidRenameFiles` が受け取る形） */
export interface RenamedFileUris {
	oldUri: vscode.Uri;
	newUri: vscode.Uri;
}

/** イベントのファイル一覧を計画が扱う形へ移す */
function toRenames(files: readonly RenamedFileUris[]): PathRename[] {
	return files.map((f) => ({ oldPath: f.oldUri.fsPath, newPath: f.newUri.fsPath }));
}

/**
 * `onWillRenameFiles` の `waitUntil` へ返す編集を作る。
 *
 * 返した `renameFile` はユーザーの移動と同じ取り消し単位で適用される。
 *
 * 設定が未初期化・ワークスペース未設定など、計画を立てられない状況では**空の編集**を返す。
 * ここで例外を投げるとユーザーのリネームそのものが失敗するので、追随できないときは
 * 静かに何もしない（取りこぼした訳文は段階1の孤立として画面に出る）。
 */
export function buildRenameFollowEdit(files: readonly RenamedFileUris[]): vscode.WorkspaceEdit {
	const edit = new vscode.WorkspaceEdit();
	const renames = toRenames(files);
	if (renames.length === 0) {
		return edit;
	}

	let plan: ReturnType<typeof planRenameFollow>;
	try {
		plan = planRenameFollow(renames, createRenameFollowProbe(Configuration.getInstance()));
	} catch (error) {
		logger.warn("rename", "Could not plan how to follow a move", { error: (error as Error).message });
		return edit;
	}

	for (const companion of plan.companions) {
		edit.renameFile(vscode.Uri.file(companion.oldPath), vscode.Uri.file(companion.newPath));
	}
	if (plan.companions.length > 0) {
		logger.info("rename", "Moving translations along with their source", {
			companions: plan.companions.map((c) => `${c.oldPath} -> ${c.newPath}`),
		});
	}
	for (const held of plan.blocked) {
		// 連れて行けなかった訳文は原文を失うので孤立としてツリーに出る。
		// 通知は出さない — フォルダ移動では何十件も出うるうえ、気づきの場所は
		// ツリーとステータスバーに集約している（ux.md §3.3）
		logger.warn("rename", "Left a translation behind: its destination is occupied", {
			oldPath: held.rename.oldPath,
			newPath: held.rename.newPath,
			reason: held.reason,
		});
	}
	return edit;
}

/**
 * `onDidRenameFiles` から呼ぶ。移動が済んだ実態に合わせて `unit-state` の行を付け替える。
 *
 * 行の付け替えに失敗しても、移動そのものは既に済んでいる。行が旧パスに残るだけなので、
 * 訳文は孤立としてツリーに出る（黙って消えることはない）。
 */
export async function completeRenameFollow(files: readonly RenamedFileUris[]): Promise<void> {
	const renames = toRenames(files);
	if (renames.length === 0) {
		return;
	}
	try {
		const entryMoves = planEntryMoves(renames, createRenameFollowProbe(Configuration.getInstance()));
		const result = await relocateUnitEntries(entryMoves, Configuration.getInstance());
		if (result.movedEntries > 0) {
			logger.info("rename", "Followed a move in unit-state", {
				moves: entryMoves.length,
				movedEntries: result.movedEntries,
			});
		}
	} catch (error) {
		logger.error("rename", "Failed to follow a move in unit-state", {
			error: (error as Error).message,
		});
	}
}
