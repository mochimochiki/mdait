/**
 * @file discard-orphan.ts
 * @description
 *   「原文と結びついていない訳文」をツリーから破棄する操作。
 *
 *   孤立の判定そのものは記録されておらず、収集のたびに計算されている（ADR-260806-01）。
 *   ここでも実行の直前に測り直す — ツリーの表示は古いことがあり、その間に原文が
 *   git checkout などで戻っていれば、破棄する理由はもう無い。
 *
 * @module commands/markers/discard-orphan
 */
import * as path from "node:path";
import * as vscode from "vscode";
import { type StatusItem, StatusItemType } from "../../core/status/status-item";
import { isOrphanTarget } from "../../core/unit-state/orphan-target";
import { Configuration } from "../../infra/config/configuration";
import { createOrphanTargetProbe } from "../../infra/workspace/orphan-probe";
import { forgetOrphanPath } from "../sync/sync-command";
import { discardTargetFile } from "./unit-mutation";

/**
 * 孤立した訳文をごみ箱へ移す。
 *
 * modal で確認する。文言に「ごみ箱へ移動します」と明記するのは、**取り返しがつくことを
 * 伝える機会がここしか無い**ためである（ADR-260805-01 で一括 Keep に modal を掛けたときと同じ考え方）。
 */
export async function discardOrphanTargetCommand(item?: StatusItem): Promise<void> {
	if (item?.type !== StatusItemType.File || !item.filePath) {
		vscode.window.showErrorMessage(vscode.l10n.t("Invalid file item"));
		return;
	}
	const filePath = item.filePath;
	const config = Configuration.getInstance();

	// 実行の直前に測り直す（ツリーは古いことがある）。
	// 判定は設定とワークスペースを引くので、未設定なら落ちる — コマンドを生の例外で
	// 終わらせるとツリーのボタンがデッドエンドになる（UX-P7）
	let stillOrphan: boolean;
	try {
		stillOrphan = isOrphanTarget(filePath, createOrphanTargetProbe(config));
	} catch (error) {
		vscode.window.showErrorMessage(
			vscode.l10n.t("Could not check '{0}': {1}", path.basename(filePath), (error as Error).message),
		);
		return;
	}
	if (!stillOrphan) {
		vscode.window.showInformationMessage(
			vscode.l10n.t("This translation is linked to a source file again. Nothing was discarded."),
		);
		return;
	}

	const fileName = path.basename(filePath);
	const confirmLabel = vscode.l10n.t("Move to Trash");
	const choice = await vscode.window.showWarningMessage(
		vscode.l10n.t("Discard the translation '{0}'?", fileName),
		{
			modal: true,
			detail: vscode.l10n.t(
				"Its source file no longer exists. The file is moved to the trash, so you can restore it from there. Its translation state is removed as well.",
			),
		},
		confirmLabel,
	);
	if (choice !== confirmLabel) {
		return;
	}

	try {
		await discardTargetFile(filePath, config);
	} catch (error) {
		vscode.window.showErrorMessage(
			vscode.l10n.t("Could not discard '{0}': {1}", fileName, (error as Error).message),
		);
		return;
	}
	// 記憶に残したままだと、同じパスに訳文が作り直されて再び孤立しても黙ることになる
	forgetOrphanPath(filePath);
	vscode.window.showInformationMessage(vscode.l10n.t("Moved '{0}' to the trash.", fileName));
}
