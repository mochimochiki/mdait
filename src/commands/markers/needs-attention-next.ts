import * as vscode from "vscode";
import type { UnitStatusItem } from "../../core/status/status-item";
import { StatusManager } from "../../core/status/status-manager";
import { getSelectedScopeDirs } from "../../core/status/status-scope";
import { Configuration } from "../../infra/config/configuration";

/**
 * 「次の要対応へ」コマンド。
 *
 * 要対応キューは一覧があるだけでは連続裁定にならず、1件裁定するたびにツリーへ戻る往復が
 * 残る（ux.md B-8）。本コマンドは現在位置の次の項目へ1操作で移動し、末尾まで来たら先頭へ
 * 回ることでキューを一巡できるようにする。
 *
 * 裁定直後に自動で画面が飛ぶことはしない（驚きが大きく VS Code 標準の作法から外れるため。
 * UX-P5）。押したときだけ動く。
 */
export async function needsAttentionNextCommand(): Promise<void> {
	const units = collectSortedNeedsAttentionUnits();

	if (units.length === 0) {
		vscode.window.showInformationMessage(
			vscode.l10n.t("No units need attention."),
		);
		return;
	}

	const index = findNextIndex(units);
	const target = units[index];

	await vscode.commands.executeCommand(
		"mdait.jumpToUnit",
		target.filePath,
		target.startLine ?? 0,
	);

	// キューの何件目かを一時的に示す（通知を増やさず視界の隅で進捗が分かるようにする）
	vscode.window.setStatusBarMessage(
		vscode.l10n.t("Needs Attention: {0} of {1}", index + 1, units.length),
		4000,
	);
}

/**
 * 選択中の transPair に属する要対応ユニットを、ツリーと同じ順序で取得する
 */
function collectSortedNeedsAttentionUnits(): UnitStatusItem[] {
	const config = Configuration.getInstance();
	return StatusManager.getInstance()
		.getStatusItemTree()
		.getNeedsAttentionUnits(getSelectedScopeDirs(config));
}

/**
 * アクティブエディタの現在位置より後ろにある最初の項目を探す。
 * 見つからなければ先頭へ回る（末尾で行き止まりにしない）。
 */
function findNextIndex(units: UnitStatusItem[]): number {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		return 0;
	}

	const currentPath = editor.document.uri.fsPath;
	const currentLine = editor.selection.active.line;

	const found = units.findIndex((unit) => {
		if (unit.filePath !== currentPath) {
			return unit.filePath > currentPath;
		}
		return (unit.startLine ?? 0) > currentLine;
	});

	return found >= 0 ? found : 0;
}
