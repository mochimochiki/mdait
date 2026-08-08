/**
 * @file status-bar-summary.ts
 * @description
 *   抱えている needs 件数をステータスバーに常駐表示する（ADR-260802-03）。
 *
 *   原文を保存すると autoSync が黙って `need:revise` を付けるため、以前は
 *   「ツリーの数字が減ったこと」に自分で気づくしかなかった。変化のたびに
 *   トーストを出すと通知疲れになるので、受動的に気づける常駐サマリを1つだけ置く
 *   （ux.md §3.3「変化の気づきは1箇所に集約する」）。
 *
 *   集計範囲はツリー本体と同じ「選択中の transPair」（`getSelectedScopeDirs`）。
 *   人間とエージェントで件数が食い違わないようにするため、算出点を分けない。
 * @module ui/status/status-bar-summary
 */
import * as vscode from "vscode";
import type { StatusManager } from "../../core/status/status-manager";
import { getSelectedScopeDirs } from "../../commands/shared/status-scope";
import type { Configuration } from "../../infra/config/configuration";

/** 集計結果（表示の組み立てをテストできるように分離する） */
export interface StatusBarCounts {
	/** trans が自動で処理できる翻訳待ち（need:translate / need:revise） */
	pendingTranslation: number;
	/** 人の裁定が要る件数（need:review / need:verify-deletion） */
	needsAttention: number;
	/** 原文と結びついていない訳文の数 */
	orphanTargets: number;
}

/**
 * ステータスバーに出す文字列を組み立てる純関数。
 * 0 件の種別は出さない（見えている数字は必ず「やることがある」を意味する）。
 */
export function buildStatusBarText(counts: StatusBarCounts): string {
	const parts: string[] = [];
	if (counts.pendingTranslation > 0) {
		parts.push(vscode.l10n.t("{0} to translate", counts.pendingTranslation));
	}
	if (counts.needsAttention > 0) {
		parts.push(vscode.l10n.t("{0} to check", counts.needsAttention));
	}
	// 孤立は「訳文が置き去りになっている」という別種の事実なので、
	// 要対応の件数に混ぜず独立した項目として出す
	if (counts.orphanTargets > 0) {
		parts.push(vscode.l10n.t("{0} without source", counts.orphanTargets));
	}
	return parts.length > 0 ? `$(globe) ${parts.join(" / ")}` : "";
}

/**
 * needs 件数のステータスバー常駐表示。
 *
 * やることが 0 件のときは項目ごと隠す（何も無いのに常駐すると、視界の隅の
 * 変化に意味がなくなる）。
 */
export class StatusBarSummary implements vscode.Disposable {
	private readonly item: vscode.StatusBarItem;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly statusManager: StatusManager,
		private readonly configuration: Configuration,
	) {
		this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
		// クリックで mdait のツリーへ（数字から中身へ1操作でたどれるようにする）
		this.item.command = "mdait.status.focus";
		this.disposables.push(this.statusManager.onStatusTreeChanged(() => this.refresh()));
		this.refresh();
	}

	/** 現在の件数を集計する */
	public collect(): StatusBarCounts {
		const tree = this.statusManager.getStatusItemTree();
		const scopeDirs = getSelectedScopeDirs(this.configuration);
		return {
			pendingTranslation: tree.countPendingTranslationUnits(scopeDirs),
			needsAttention: tree.getNeedsAttentionUnits(scopeDirs).length,
			orphanTargets: tree.countOrphanTargetFiles(scopeDirs),
		};
	}

	/** 表示を更新する */
	public refresh(): void {
		if (!this.configuration.isConfigured()) {
			this.item.hide();
			return;
		}
		const counts = this.collect();
		const text = buildStatusBarText(counts);
		if (!text) {
			this.item.hide();
			return;
		}
		this.item.text = text;
		this.item.tooltip = vscode.l10n.t(
			"mdait: {0} unit(s) waiting for translation, {1} unit(s) waiting for your decision, {2} translation(s) with no source file. Click to open the mdait view.",
			counts.pendingTranslation,
			counts.needsAttention,
			counts.orphanTargets,
		);
		this.item.show();
	}

	dispose(): void {
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.item.dispose();
	}
}
