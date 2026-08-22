/**
 * @file unit-mutation.ts
 * @description
 *   マーカー／ユニット状態を書き換える操作すべてが通る共通の入出力手順。
 *
 *   **新しいサーフェス（CodeLens・ツリー・LM Tool・コマンド）を足すとき、
 *   マーカーの読み書きを自分で書いてはならない。必ずここを通ること。**
 *   排他制御・未保存バッファの反映・ストア保存・ステータス更新はここにしか無く、
 *   1つでも欠けると「押したのにツリーが古いまま」（ux.md B-5 と同じ原因系）が再発する。
 *   実際、以前は CodeLens が独自に本文を書き換えていたため、frontmatter と非MDファイルの
 *   need 解除でステータス更新が呼ばれず、本文マーカーの更新は `sync.autoSyncOnSave` が
 *   有効なときにだけ偶然直る状態になっていた。
 *
 * @module commands/markers/unit-mutation
 */
import * as fs from "node:fs";
import * as vscode from "vscode";
import type { Markdown } from "../../core/markdown/mdait-markdown";
import { markdownParser } from "../../core/markdown/parser";
import { StatusManager } from "../../core/status/status-manager";
import { isOrphanTarget } from "../../core/unit-state/orphan-target";
import type { PathRename } from "../../core/unit-state/rename-plan";
import { UnitStateStore } from "../../core/unit-state/unit-state-store";
import type { Configuration } from "../../infra/config/configuration";
import { type MarkerIO, resolveMarkerIO } from "../../infra/config/marker-io";
import { flushDirtyDocument } from "../../infra/workspace/dirty-document";
import { FileExplorer } from "../../infra/workspace/file-explorer";
import { FileMutex } from "../../infra/workspace/file-mutex";
import { Logger } from "../../infra/logging/logger";
import { createOrphanTargetProbe } from "../../infra/workspace/orphan-probe";
import { ensureMdaitDir } from "../../infra/workspace/mdait-dir";
import { withUnitStateLock } from "../../infra/workspace/unit-state-lock";
import { toWorkspaceRelativePath } from "../../infra/workspace/workspace-path";
import { isUnitStateBacked } from "../file-handler/file-type";

/** 書き換え操作の結果が最低限持つべき情報 */
export interface UnitMutationResult {
	/** 1件以上の変更を行ったか。false のときファイル書き込み・ステータス更新は行われない */
	changed: boolean;
}

/** ファイルが原文側か訳文側かを判定する（ワークスペース未設定等は訳文扱い） */
function resolveFileRole(absPath: string, config: Configuration): "source" | "target" {
	try {
		return new FileExplorer().isSourceFile(absPath, config) ? "source" : "target";
	} catch {
		return "target";
	}
}

/**
 * ファイル単位の書き換えを排他・整合つきで実行する（ファイル種別を問わない外側の層）。
 *
 * - 読み取り〜書き戻しの間は FileMutex で排他する（sync / trans との競合防止）
 * - 状態が unit-state に載るファイル（非Markdown、または external マーカー）ではストアをロードし、変更時に保存する
 * - 変更があったときだけステータスを更新する（冪等性を保つため、無変更なら何もしない）
 *
 * **ストアに載るファイルでは `unit-state-lock` も取る。** `FileMutex` はファイルパス単位
 * なので、ストア全体の「読み込んでから書き戻すまで」は守れない。`syncCommand` は開始時に
 * `load()` を無条件に呼び終了時に `save()` するので、この区間と重なると書き換えが
 * 読み捨てられるか上書きで消える — どちらも無言で起きる（ADR-260810-04）。
 *
 * @param absPath 対象ファイルの絶対パス
 * @param config 設定
 * @param mutate 実際の書き換え。changed:false を返した場合は保存・更新を行わない
 */
export async function withFileMutation<T extends UnitMutationResult>(
	absPath: string,
	config: Configuration,
	mutate: () => Promise<T>,
): Promise<T> {
	// 非Markdownファイルは embedded モードでも状態がストアにしか無いため、
	// external 判定だけで済ませてはならない（済ませると保存されず need が復活する）
	const storeBacked = isUnitStateBacked(absPath, config.isExternalMarkers());
	if (!storeBacked) {
		// ストアに触らないので、ストア全体の排他は取らない（sync を無駄に待たせない）
		return runFileMutation(absPath, false, mutate);
	}
	return withUnitStateLock(() => runFileMutation(absPath, true, mutate));
}

/**
 * `withFileMutation` の中身（ストア全体の排他を取ったあと）。
 *
 * ロックの獲得と処理本体を分けているのは、ストアに触らないファイルで無駄に待たせないため。
 * **ストアの `ensureLoaded` から `save()` までがこの関数の中に収まっていること**が要点で、
 * 外に出すと排他の意味が無くなる。
 */
async function runFileMutation<T extends UnitMutationResult>(
	absPath: string,
	storeBacked: boolean,
	mutate: () => Promise<T>,
): Promise<T> {
	if (storeBacked) {
		const mdaitDir = await ensureMdaitDir();
		if (mdaitDir) {
			UnitStateStore.getInstance().ensureLoaded(mdaitDir);
		}
	}

	let outcome: T | undefined;
	await FileMutex.getInstance().runExclusive([absPath], async () => {
		outcome = await mutate();
	});

	// runExclusive は mutate を必ず実行するため undefined にはならない
	const result = outcome as T;

	if (result.changed) {
		if (storeBacked) {
			const mdaitDir = await ensureMdaitDir();
			if (mdaitDir) {
				UnitStateStore.getInstance().save(mdaitDir);
			}
		}
		await StatusManager.getInstance().refreshFileStatus(absPath);
	}
	return result;
}

/** 訳文ファイルの破棄結果 */
export interface DiscardFileResult extends UnitMutationResult {
	/** 削除した `unit-state` の行数 */
	removedEntries: number;
}

/**
 * 訳文ファイルそのものを手放す（孤立訳文の破棄）。
 *
 * **ごみ箱へ移す**（`useTrash`）。mdait がユーザーの文書ファイルを消すのはこの操作だけで、
 * 確認の要否と実装は「破壊的か」ではなく「間違えたとき取り返しがつくか」で決めている
 * （ADR-260804-01 / -260805-01）。ごみ箱経由なら取り返しがつく側に入る。
 *
 * 排他区間の中でファイルを消してから行を消す。順序を逆にすると、削除に失敗したときに
 * 行だけが失われる（＝画面から孤立が消えるのに実体は残り、二度と気づけなくなる）。
 * 行の削除はマーカー保管方式に関わらず行う — embedded 運用でも、embed で本文へ
 * 書き戻せなかった行や、モードを切り替える前の行が残っていることがある。
 *
 * **孤立していない訳文は手放さない。** 呼び出し側の確認だけに頼ると、この関数が
 * 「どの訳文でもごみ箱へ送れる入口」になる。AGENTS.md が唯一の入口と定めた以上、
 * 前提の確認も内側に置く。
 */
export async function discardTargetFile(absPath: string, config: Configuration): Promise<DiscardFileResult> {
	if (!isOrphanTarget(absPath, createOrphanTargetProbe(config))) {
		throw new Error(vscode.l10n.t("This translation still has a source file; it was not discarded."));
	}

	// 未保存のバッファを先に反映する。ダーティなタブを残したままファイルを消すと、
	// その後の保存で**行の無い訳文**として復活し、「実体だけが残る」状態を自分で作ってしまう
	await flushDirtyDocument(absPath);

	// ここも「ストアを読み込んでから書き戻すまで」の区間を持つ。sync と重なると
	// 行の削除が読み捨てられ、ファイルだけ消えて行が残る（ADR-260810-04）
	return withUnitStateLock(async () => {
		const mdaitDir = await ensureMdaitDir();
		if (mdaitDir) {
			UnitStateStore.getInstance().ensureLoaded(mdaitDir);
		}

		let removedEntries = 0;
		await FileMutex.getInstance().runExclusive([absPath], async () => {
			await vscode.workspace.fs.delete(vscode.Uri.file(absPath), { useTrash: true, recursive: false });
			try {
				removedEntries = UnitStateStore.getInstance().removeEntriesByPath(toWorkspaceRelativePath(absPath));
			} catch {
				// ワークスペース未設定。ファイルは消えているので、行は次の sync の掃除に任せる
				removedEntries = 0;
			}
		});

		if (mdaitDir && removedEntries > 0) {
			UnitStateStore.getInstance().save(mdaitDir);
		}
		// ファイルが実在しないので、ステータス更新はツリーからの取り除きとして働く
		await StatusManager.getInstance().refreshFileStatus(absPath);

		return { changed: true, removedEntries };
	});
}

/** `unit-state` の行をファイルの移動に追随させた結果 */
export interface RelocateEntriesResult extends UnitMutationResult {
	/** `path` を付け替えた行数 */
	movedEntries: number;
}

/**
 * ファイルの移動に `unit-state` の行を追随させる（リネーム・フォルダ移動）。
 *
 * **移動そのものはここでは行わない。** ファイルを動かすのはユーザーの操作と同じ
 * 取り消し単位に相乗りする必要があり（`onWillRenameFiles` の `waitUntil`）、
 * ここは「動いたあとに行を合わせる」役目だけを持つ。
 *
 * **必ず保存する。** `syncCommand` は毎回 `load()` を無条件に呼んでメモリ上の変更を
 * 捨てるため、ここで保存せずに終わると、次の sync が走った瞬間に付け替えが無言で消え、
 * 行は旧パスのまま取り残される（docs/design/unit-state.md §8）。
 *
 * 排他は移動元と移動先の両方に掛ける。移動元だけだと、移動先へ向けて走っている
 * sync や翻訳と重なる。
 *
 * @param moves 実際に行われた移動（絶対パス。ファイル・ディレクトリを問わない）
 * @param config 設定（どの移動が管理下のものかの判定に使う）
 */
export async function relocateUnitEntries(
	moves: readonly PathRename[],
	config: Configuration,
): Promise<RelocateEntriesResult> {
	if (moves.length === 0) {
		return { changed: false, movedEntries: 0 };
	}

	const mdaitDir = await ensureMdaitDir();
	if (!mdaitDir) {
		return { changed: false, movedEntries: 0 };
	}

	const lockKeys = moves.flatMap((m) => [m.oldPath, m.newPath]);
	let movedEntries = 0;
	// ストアの読み込みから保存までを sync と排他する。ここを外すと、sync が走っている
	// 最中に届いた移動は `load()` に読み捨てられるか `save()` に上書きされて無言で消え、
	// 行だけが旧パスに取り残される（docs/design/unit-state.md §8）
	await withUnitStateLock(async () => {
		const store = UnitStateStore.getInstance();
		store.ensureLoaded(mdaitDir);
		await FileMutex.getInstance().runExclusive(lockKeys, async () => {
			for (const move of moves) {
				try {
					movedEntries += store.movePath(
						toWorkspaceRelativePath(move.oldPath),
						toWorkspaceRelativePath(move.newPath),
					);
				} catch (error) {
					// ワークスペース未設定などでパスを相対化できない。行は動かせないが、
					// 他の移動まで巻き添えにしない（残った行は孤立としてツリーに出る）
					Logger.getInstance().warn("rename", "Could not follow a move in unit-state", {
						oldPath: move.oldPath,
						newPath: move.newPath,
						error: (error as Error).message,
					});
				}
			}
		});
		if (movedEntries > 0) {
			store.save(mdaitDir);
		}
	});

	// 表示の更新は管理下に関わる移動のときだけ行う。ワークスペースのどこかで
	// フォルダの名前を変えるたびにツリーを丸ごと作り直すのは、払う理由の無い代償である
	if (movedEntries > 0 || moves.some((move) => touchesManagedPath(move, config))) {
		await refreshStatusAfterMoves(moves);
	}
	return { changed: movedEntries > 0, movedEntries };
}

/** その移動は管理下（どれかのペアの原文・訳文）に関わるか */
function touchesManagedPath(move: PathRename, config: Configuration): boolean {
	try {
		const explorer = new FileExplorer();
		const managed = (p: string) => explorer.isSourceFile(p, config) || explorer.isTargetFile(p, config);
		return managed(move.oldPath) || managed(move.newPath);
	} catch {
		return false; // ワークスペース未設定。判定できないなら触らない
	}
}

/**
 * 移動後のステータス表示を合わせる。
 *
 * ディレクトリの移動は1件のイベントでファイルが何十件も動くため、どのファイルが動いたかを
 * ここでは知らない。**ツリーを丸ごと作り直す**のが唯一取りこぼしの無いやり方である。
 * ファイルだけの移動なら旧パス（ツリーから取り除かれる）と新パスの2点で足りる。
 *
 * 行が1行も動かなかった場合も更新する — embedded 運用では動かす行がそもそも無く、
 * それでもツリーの中身は移動によって変わっているため（`changed` に紐づけると
 * embedded でリネームしたときだけツリーが古いまま残る）。
 */
async function refreshStatusAfterMoves(moves: readonly PathRename[]): Promise<void> {
	const statusManager = StatusManager.getInstance();
	const hasDirectoryMove = moves.some((move) => {
		try {
			return fs.statSync(move.newPath).isDirectory();
		} catch {
			return false;
		}
	});
	if (hasDirectoryMove) {
		await statusManager.buildStatusItemTree();
		return;
	}
	for (const move of moves) {
		await statusManager.refreshFileStatus(move.oldPath);
		await statusManager.refreshFileStatus(move.newPath);
	}
}

/** Markdown 書き換えの作業コンテキスト */
export interface MarkdownMutationContext {
	/** パース済みドキュメント。マーカーを直接変異させてよい */
	parsed: Markdown;
	/** external の書き戻しに使う provider / ctx */
	io: MarkerIO;
}

/**
 * Markdown ファイルの書き換えを実行する（`withFileMutation` の Markdown 版）。
 *
 * embedded / external の差異は `resolveMarkerIO` 経由の parse/stringify に乗ることで吸収する。
 * マーカー境界の探索はパーサーに委譲するため、コードブロック内のサンプルマーカーには
 * 誤マッチしない（生の正規表現探索は行わない）。
 *
 * **書き戻すのは中身が変わったときだけ**（`changed:true` でも、出来上がりが読み込んだ内容と
 * 同じならファイルには触れない）。external では need 解除・Keep・isolate 宣言が本文を
 * 変えないため、この判定が「原文を1バイトも書き換えない」約束を守る唯一の場所になる。
 *
 * @param absPath 対象ファイルの絶対パス
 * @param config 設定
 * @param mutate パース済みドキュメントを変異させ、結果を返す。changed:false なら何もしない
 */
export async function withMarkdownMutation<T extends UnitMutationResult>(
	absPath: string,
	config: Configuration,
	mutate: (ctx: MarkdownMutationContext) => Promise<T> | T,
): Promise<T> {
	const role = resolveFileRole(absPath, config);

	return withFileMutation(absPath, config, async () => {
		// 本文を読むのはこの経路だけなので、未保存バッファの反映もここで行う
		// （非Markdownの need 解除は本文に触れないため、頼んでいない保存を走らせない）
		await flushDirtyDocument(absPath);

		const decoder = new TextDecoder("utf-8");
		const content = decoder.decode(await vscode.workspace.fs.readFile(vscode.Uri.file(absPath)));
		const io = resolveMarkerIO(config, absPath, role);
		const parsed = markdownParser.parse(content, config, io.provider, io.ctx);

		const result = await mutate({ parsed, io });

		if (result.changed) {
			// stringify は「文字列を作る」だけの関数ではない。external では detachMarkers が
			// ここでマーカーをストアへ引き取るため、書き込みを見送るときも必ず呼ぶ
			const updated = markdownParser.stringify(
				{ frontMatter: parsed.frontMatter, units: parsed.units },
				io.provider,
				io.ctx,
			);
			// **中身が1文字も変わっていなければ書かない。**
			// external では need 解除・Keep（独立化）・isolate 宣言で本文に変化が無い
			// （マーカーはストアにある）。それでも書き戻すと、パーサーを通った整形が
			// そのまま原文に焼き付く — 実測では改行コードが CRLF から LF に変わり、
			// ユニット間の余分な空行と末尾の空行が消えた。external の存在理由は
			// 「原文を1バイトも書き換えない」ことなので、これは約束を破っている
			// （ADR-260802-04 / ADR-260814-01）。
			//
			// 判定にモードも原文/訳文も持ち込まない。「external なら書かない」にすると、
			// external でも本文から章そのものを消す deleteUnit が壊れる（章が消えない）。
			// 中身の比較はモードに依らず正しく、embedded でも無駄な書き込みが減る。
			if (updated !== content) {
				const encoder = new TextEncoder();
				await vscode.workspace.fs.writeFile(vscode.Uri.file(absPath), encoder.encode(updated));
			}
		}
		return result;
	});
}
