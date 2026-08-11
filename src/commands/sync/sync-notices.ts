/**
 * @file sync-notices.ts
 *   sync が「ふつうと違うこと」を伝えるトーストの組み立てと、**まとめ方**。
 *
 *   1回の明示 sync は、次のどれもが同時に起こりうる。
 *
 *   - 自動削除を見送って確認待ちにした
 *   - 原文が空だったので訳文に触らなかった
 *   - 訳文が空だったので状態を守って中止した
 *   - 新しく孤立した訳文ができた
 *   - 原文を失った訳文ユニットを削除した
 *
 *   **1本ずつはどれも `ux.md` §3.3 に照らして正しい** — 通知に載せてよいのは「実行の結果と、
 *   結果に対する次の一手」で、これらはすべて sync の実行結果そのものだからである。
 *   破れるのは重なったときだけで、同じ §3.3 の「変化の気づきは1箇所に集約する」に反する。
 *   完了サマリと合わせて最大6本が積み上がると、どれも読まれない。
 *
 *   そこで**数で切り替える**。1件なら従来どおり、そのできごとに合った説明と導線を出す。
 *   2件以上になったときだけ1本にまとめ、導線を mdait ビューの1つに絞る
 *   （「同じ重みのボタンを3つ以上並べない」）。**普段の運用では1件しか起きない**ので、
 *   見え方は変わらない。変わるのは「いくつも重なった」異常時だけである。
 *
 * @module commands/sync/sync-notices
 */
import * as vscode from "vscode";
import { Logger, formatError } from "../../infra/logging/logger";

const logger = Logger.getInstance();

/** トーストのボタン1つぶん */
export interface SyncNoticeAction {
	/** ボタンの表示名 */
	readonly label: string;
	/** 押されたときの処理 */
	readonly run: () => Thenable<unknown> | undefined;
}

/** sync のできごと1件ぶんの伝え方 */
export interface SyncNotice {
	/** ログに出す識別子（何をまとめたかを追えるようにする） */
	readonly kind: string;
	/** **単独で出すとき**の本文。なぜ起きたか・次に何をすればよいかまで書く */
	readonly detail: string;
	/** **まとめて出すとき**の1行。件数と何が起きたかだけに絞る */
	readonly summary: string;
	/** 単独で出すときのボタン。まとめるときは使わない */
	readonly action?: SyncNoticeAction;
}

/** 押されたボタンに応じて処理を走らせ、失敗はログに落とす */
function handleChoice(kind: string, choice: string | undefined, action: SyncNoticeAction | undefined): void {
	if (!action || choice !== action.label) {
		return;
	}
	const result = action.run();
	if (result) {
		// VS Code の Thenable には .catch が無いため .then の第2引数で拒否を捕捉する
		void result.then(undefined, (error: unknown) => {
			logger.error("sync", "Sync notice action failed", { kind, ...formatError(error) });
		});
	}
}

/**
 * できごとを伝える。**1件なら個別に、2件以上なら1本にまとめる。**
 *
 * fire-and-forget にする。ここで await すると通知をユーザーが閉じるまで sync が解決せず、
 * 呼び出し側の処理中フラグ（sync ボタンのアニメーション）が終わらない
 * （ADR-260705-01 の非AI sync は同期処理完結が前提）。
 *
 * @param notices 起きたできごと。空の要素は呼び出し側で落としておくこと
 */
export function showSyncNotices(notices: readonly SyncNotice[]): void {
	if (notices.length === 0) {
		return;
	}
	if (notices.length === 1) {
		const notice = notices[0];
		const buttons = notice.action ? [notice.action.label] : [];
		void vscode.window
			.showWarningMessage(notice.detail, ...buttons)
			.then((choice) => handleChoice(notice.kind, choice, notice.action))
			.then(undefined, (error: unknown) => {
				logger.error("sync", "Sync notice failed", { kind: notice.kind, ...formatError(error) });
			});
		return;
	}

	// トーストの本文で改行は詰められるため、区切り文字で1行に並べる
	const body = notices.map((n) => n.summary).join(" / ");
	const showLabel = vscode.l10n.t("Show in mdait");
	logger.info("sync", "Combined sync notices into one", {
		count: notices.length,
		kinds: notices.map((n) => n.kind),
	});
	void vscode.window
		.showWarningMessage(
			vscode.l10n.t("Synchronization completed, but {0} things need a look: {1}", notices.length, body),
			showLabel,
		)
		.then((choice) => {
			if (choice === showLabel) {
				// VS Code が view id から自動生成するフォーカスコマンド
				return vscode.commands.executeCommand("mdait.status.focus");
			}
			return undefined;
		})
		.then(undefined, (error: unknown) => {
			logger.error("sync", "Combined sync notice failed", { ...formatError(error) });
		});
}
