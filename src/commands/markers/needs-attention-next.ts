import * as vscode from "vscode";
import type { UnitStatusItem } from "../../core/status/status-item";
import { StatusManager } from "../../core/status/status-manager";
import { Configuration } from "../../infra/config/configuration";
import { getSelectedScopeDirs } from "../shared/status-scope";

/** 「次の要対応へ」の探索起点 */
export interface NeedsAttentionOrigin {
	filePath: string;
	line: number;
}

/**
 * 「次の要対応へ」コマンド。
 *
 * 要対応キューは一覧があるだけでは連続裁定にならず、1件裁定するたびにツリーへ戻る往復が
 * 残る（ux.md B-8）。本コマンドは現在位置の次の項目へ1操作で移動し、末尾まで来たら先頭へ
 * 回ることでキューを一巡できるようにする。
 *
 * 裁定直後に自動で画面が飛ぶことはしない（驚きが大きく VS Code 標準の作法から外れるため。
 * UX-P5）。押したときだけ動く。
 *
 * @param range CodeLens から呼ばれた場合のクリック行。CodeLens のクリックはカーソルを
 *   動かさないため、押した行を起点にするにはこの引数が要る（無いとカーソル位置が起点になり、
 *   スクロールして押したときに前へ戻る）。
 */
export async function needsAttentionNextCommand(range?: vscode.Range): Promise<void> {
	const units = collectSortedNeedsAttentionUnits();

	if (units.length === 0) {
		// 「要対応」= review / verify-deletion のみ。need:translate は含まれないため、
		// 「対応すべきものは何もない」と誤読されない文言で何を調べたかを明示する。
		vscode.window.showInformationMessage(vscode.l10n.t("No units are awaiting review or deletion verification."));
		return;
	}

	const index = findNextIndex(units, resolveOrigin(range));
	const target = units[index];

	await vscode.commands.executeCommand("mdait.jumpToUnit", target.filePath, target.startLine ?? 0);

	// キューの何件目かを一時的に示す（通知を増やさず視界の隅で進捗が分かるようにする）
	vscode.window.setStatusBarMessage(vscode.l10n.t("Needs Attention: {0} of {1}", index + 1, units.length), 4000);
}

/**
 * 選択中の transPair に属する要対応ユニットを、ツリーと同じ順序で取得する
 */
function collectSortedNeedsAttentionUnits(): UnitStatusItem[] {
	const config = Configuration.getInstance();
	return StatusManager.getInstance().getStatusItemTree().getNeedsAttentionUnits(getSelectedScopeDirs(config));
}

/**
 * 探索の起点を決める。CodeLens から行が渡された場合はその行、
 * それ以外はアクティブエディタのカーソル位置を使う。
 */
function resolveOrigin(range?: vscode.Range): NeedsAttentionOrigin | undefined {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		return undefined;
	}
	return {
		filePath: editor.document.uri.fsPath,
		line: range ? range.start.line : editor.selection.active.line,
	};
}

/**
 * 起点より後ろにある最初の項目を探す。見つからなければ先頭へ回る（末尾で行き止まりにしない）。
 *
 * units は `compareNeedsAttentionUnits`（ファイルパス昇順→開始行昇順）でソート済みである
 * ことを前提とし、比較規則もそれに一致させる。
 */
export function findNextIndex(units: UnitStatusItem[], origin: NeedsAttentionOrigin | undefined): number {
	if (!origin) {
		return 0;
	}

	const found = units.findIndex((unit) => {
		if (unit.filePath !== origin.filePath) {
			return unit.filePath > origin.filePath;
		}
		return (unit.startLine ?? 0) > origin.line;
	});

	return found >= 0 ? found : 0;
}
