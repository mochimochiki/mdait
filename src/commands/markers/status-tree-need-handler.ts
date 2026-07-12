/**
 * @file status-tree-need-handler.ts
 * @description
 *   StatusTreeのユニット行コンテキストメニューから呼び出す need 裁定アクション
 *   （verify-deletion の Keep/Delete、isolate の宣言/解除）。CodeLens の同名アクションと
 *   同じコア関数（resolve-need.ts / delete-unit.ts / declare-isolate.ts）に委譲することで、
 *   人間の2つの接点（CodeLens・ツリー）とエージェント（mdait_resolve）のサーフェス対称性を保つ。
 * @module commands/markers/status-tree-need-handler
 */
import * as vscode from "vscode";
import { StatusItemType } from "../../core/status/status-item";
import type { StatusItem } from "../../core/status/status-item";
import { Configuration } from "../../infra/config/configuration";
import { declareIsolateForFile } from "./declare-isolate";
import { deleteUnitFromFile } from "./delete-unit";
import { resolveNeedForFile } from "./resolve-need";

/**
 * StatusTreeのユニット行コンテキストメニューから呼び出す need 裁定アクションハンドラ
 */
export class StatusTreeNeedHandler {
	/** verify-deletion: 保持（needを外す） */
	public async keepUnit(item?: StatusItem): Promise<void> {
		if (item?.type !== StatusItemType.Unit || !item.filePath || !item.unitHash) {
			vscode.window.showErrorMessage(vscode.l10n.t("Invalid unit item"));
			return;
		}
		const config = Configuration.getInstance();
		const result = await resolveNeedForFile(item.filePath, config, {
			unitHashes: [item.unitHash],
			needs: ["verify-deletion"],
		});
		if (result.resolved.length === 0) {
			vscode.window.showWarningMessage(vscode.l10n.t("Nothing to keep for this unit."));
		}
	}

	/** verify-deletion: 削除（ユニットをドキュメントから除去） */
	public async deleteUnit(item?: StatusItem): Promise<void> {
		if (item?.type !== StatusItemType.Unit || !item.filePath || !item.unitHash) {
			vscode.window.showErrorMessage(vscode.l10n.t("Invalid unit item"));
			return;
		}
		const confirmLabel = vscode.l10n.t("Delete");
		const choice = await vscode.window.showWarningMessage(
			vscode.l10n.t(
				"Delete unit '{0}' from the document? This removes its content — recover via git history if needed.",
				item.title ?? item.label,
			),
			{ modal: true },
			confirmLabel,
		);
		if (choice !== confirmLabel) {
			return;
		}
		const config = Configuration.getInstance();
		const result = await deleteUnitFromFile(item.filePath, item.unitHash, config);
		if (!result.deleted) {
			vscode.window.showWarningMessage(vscode.l10n.t("Could not delete unit."));
		}
	}

	/** isolate 宣言（凍結して下流伝播を止める） */
	public async markIsolated(item?: StatusItem): Promise<void> {
		if (item?.type !== StatusItemType.Unit || !item.filePath || !item.unitHash) {
			vscode.window.showErrorMessage(vscode.l10n.t("Invalid unit item"));
			return;
		}
		const config = Configuration.getInstance();
		const result = await declareIsolateForFile(item.filePath, item.unitHash, config);
		if (!result.declared) {
			vscode.window.showWarningMessage(vscode.l10n.t("Could not mark unit as isolated."));
		}
	}

	/** isolate 解除 */
	public async unisolate(item?: StatusItem): Promise<void> {
		if (item?.type !== StatusItemType.Unit || !item.filePath || !item.unitHash) {
			vscode.window.showErrorMessage(vscode.l10n.t("Invalid unit item"));
			return;
		}
		const config = Configuration.getInstance();
		const result = await resolveNeedForFile(item.filePath, config, {
			unitHashes: [item.unitHash],
			needs: ["isolate"],
		});
		if (result.resolved.length === 0) {
			vscode.window.showWarningMessage(vscode.l10n.t("Nothing to un-isolate for this unit."));
		}
	}
}
