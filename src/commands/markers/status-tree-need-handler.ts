/**
 * @file status-tree-need-handler.ts
 * @description
 *   StatusTreeのユニット行コンテキストメニューから呼び出す need 裁定アクション
 *   （review の確定、verify-deletion の Keep/Delete、isolate の宣言/解除）。
 *   CodeLens・LM Tool と同じく `getFileHandler` 経由で実行することで、人間の2つの接点と
 *   エージェントのサーフェス対称性を保つ（マーカー書き換えをここで実装しないこと）。
 * @module commands/markers/status-tree-need-handler
 */
import * as vscode from "vscode";
import { StatusItemType } from "../../core/status/status-item";
import type { StatusItem, UnitStatusItem } from "../../core/status/status-item";
import { getFileHandler } from "../file-handler/file-handler-factory";
import type { DeclareIsolateResult } from "./declare-isolate";
import type { DeleteUnitResult } from "./delete-unit";

/** deleteUnit の失敗理由を人間可読なメッセージに変換する */
function describeDeleteFailure(reason: DeleteUnitResult["reason"]): string {
	if (reason === "not-verify-deletion") {
		return vscode.l10n.t(
			"This unit does not have need:verify-deletion. Only units flagged for deletion review can be deleted this way.",
		);
	}
	return vscode.l10n.t("Unit not found.");
}

/** declareIsolate の失敗理由を人間可読なメッセージに変換する */
function describeIsolateFailure(reason: DeclareIsolateResult["reason"]): string {
	if (reason === "need-already-set") {
		return vscode.l10n.t("This unit already has a pending need. Resolve it first, then retry.");
	}
	return vscode.l10n.t("Unit not found.");
}

/** ツリー項目がユニットであることを確認し、そうでなければエラーを出して undefined を返す */
function requireUnit(item?: StatusItem): UnitStatusItem | undefined {
	if (item?.type !== StatusItemType.Unit || !item.filePath || !item.unitHash) {
		vscode.window.showErrorMessage(vscode.l10n.t("Invalid unit item"));
		return undefined;
	}
	return item;
}

/**
 * StatusTreeのユニット行コンテキストメニューから呼び出す need 裁定アクションハンドラ
 */
export class StatusTreeNeedHandler {
	/** need を1種類だけ解決する共通処理。解決0件なら警告を出す */
	private async resolveOne(item: UnitStatusItem, need: string, nothingToDo: string): Promise<void> {
		const result = await getFileHandler(item.filePath).resolveNeed(item.filePath, {
			targets: [{ kind: "unit", hash: item.unitHash }],
			needs: [need],
		});
		if (result.resolved.length === 0) {
			vscode.window.showWarningMessage(nothingToDo);
		}
	}

	/** review: レビュー済みとして need を外す */
	public async markReviewed(item?: StatusItem): Promise<void> {
		const unit = requireUnit(item);
		if (!unit) {
			return;
		}
		await this.resolveOne(unit, "review", vscode.l10n.t("Nothing to mark as reviewed for this unit."));
	}

	/** verify-deletion: 保持（needを外す） */
	public async keepUnit(item?: StatusItem): Promise<void> {
		const unit = requireUnit(item);
		if (!unit) {
			return;
		}
		await this.resolveOne(unit, "verify-deletion", vscode.l10n.t("Nothing to keep for this unit."));
	}

	/** verify-deletion: 削除（ユニットをドキュメントから除去） */
	public async deleteUnit(item?: StatusItem): Promise<void> {
		const unit = requireUnit(item);
		if (!unit) {
			return;
		}
		const confirmLabel = vscode.l10n.t("Delete");
		const choice = await vscode.window.showWarningMessage(
			vscode.l10n.t(
				"Delete unit '{0}' from the document? This removes its content — recover via git history if needed.",
				unit.title ?? unit.label,
			),
			{ modal: true },
			confirmLabel,
		);
		if (choice !== confirmLabel) {
			return;
		}
		const result = await getFileHandler(unit.filePath).deleteUnit(unit.filePath, {
			kind: "unit",
			hash: unit.unitHash,
		});
		if (!result.deleted) {
			vscode.window.showWarningMessage(describeDeleteFailure(result.reason));
			return;
		}
		vscode.window.showInformationMessage(vscode.l10n.t("Unit deleted."));
	}

	/** isolate 宣言（凍結して下流伝播を止める） */
	public async markIsolated(item?: StatusItem): Promise<void> {
		const unit = requireUnit(item);
		if (!unit) {
			return;
		}
		const result = await getFileHandler(unit.filePath).declareIsolate(unit.filePath, {
			kind: "unit",
			hash: unit.unitHash,
		});
		if (!result.declared) {
			vscode.window.showWarningMessage(describeIsolateFailure(result.reason));
			return;
		}
		vscode.window.showInformationMessage(
			vscode.l10n.t("Unit marked as isolated. It will no longer follow source updates."),
		);
	}

	/** isolate 解除 */
	public async unisolate(item?: StatusItem): Promise<void> {
		const unit = requireUnit(item);
		if (!unit) {
			return;
		}
		await this.resolveOne(unit, "isolate", vscode.l10n.t("Nothing to un-isolate for this unit."));
	}
}
