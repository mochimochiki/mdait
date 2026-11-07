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
import { type PathRename, isCaseOnlyRename, planEntryMoves, planRenameFollow } from "../../core/unit-state/rename-plan";
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
		edit.renameFile(
			vscode.Uri.file(companion.oldPath),
			vscode.Uri.file(companion.newPath),
			renameOptionsFor(companion),
		);
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
 * 訳文を連れて動かす編集の選択肢。
 *
 * VS Code は `overwrite` が**未指定のときだけ** `ignoreIfExists` を見る（`bulkFileEdits.ts` の
 * `RenameOperation`: `overwrite === undefined && ignoreIfExists && exists(newUri)` なら見送る）。
 * `overwrite: false` と並べて書くと `ignoreIfExists` は黙って効かなくなる — かつてはそう書いていた。
 *
 * - **ふつうの移動**は `ignoreIfExists` だけを渡す。計画を立ててから編集が適用されるまでの隙に
 *   行き先が作られた場合（他の拡張・並行操作）に、その1件を見送らせるためである。見送らないと
 *   移動は競合で失敗し、**ユーザーのリネームごと巻き添えにしうる** — 追随は付随的な仕事なので、
 *   失敗しても訳文を連れて行かないだけに留めなければならない。連れて行けなかった訳文は原文を失い、
 *   段階1の孤立として画面に出る。行の付け替えは移動後にディスクを実測して決めるので、
 *   見送っても行は旧パスの訳文に付いたまま正しく残る。`overwrite` が未指定でも上書きはしない
 *   （ファイルサービスは `overwrite` が真のときだけ行き先を消す）。
 * - **大文字小文字だけの改名**は `overwrite: false` を渡し、`ignoreIfExists` を効かせない。
 *   大文字小文字を区別しない環境では新しい綴りも「在る」と答えるので、`ignoreIfExists` が
 *   効くと必ず見送られる。ファイルサービスは同じファイルの綴り違いを競合と見なさないので、
 *   `overwrite: false` のままで綴りだけが変わる。
 */
function renameOptionsFor(companion: PathRename): { overwrite?: boolean; ignoreIfExists?: boolean } {
	return isCaseOnlyRename(companion) ? { overwrite: false } : { ignoreIfExists: true };
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
