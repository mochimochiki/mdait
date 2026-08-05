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
import { StatusItemType, getUnitsFromFile } from "../../core/status/status-item";
import type { FileStatusItem, StatusItem, UnitStatusItem } from "../../core/status/status-item";
import { Configuration } from "../../infra/config/configuration";
import { FileExplorer } from "../../infra/workspace/file-explorer";
import { getFileHandler } from "../file-handler/file-handler-factory";
import type { DeclareIsolateResult } from "./declare-isolate";
import type { DeleteUnitResult } from "./delete-unit";
import type { KeepUnitsResult } from "./keep-unit";

/** deleteUnit の失敗理由を人間可読なメッセージに変換する */
function describeDeleteFailure(reason: DeleteUnitResult["reason"]): string {
	if (reason === "not-verify-deletion") {
		return vscode.l10n.t(
			"This unit does not have need:verify-deletion. Only units flagged for deletion review can be deleted this way.",
		);
	}
	return vscode.l10n.t("Unit not found.");
}

/** keepUnits の失敗理由を人間可読なメッセージに変換する */
function describeKeepFailure(reason: KeepUnitsResult["skipped"][number]["reason"] | undefined): string {
	if (reason === "not-verify-deletion") {
		return vscode.l10n.t(
			"This unit does not have need:verify-deletion. Only units awaiting deletion review can be kept this way.",
		);
	}
	return vscode.l10n.t("Nothing to keep for this unit.");
}

/** declareIsolate の失敗理由を人間可読なメッセージに変換する */
function describeIsolateFailure(reason: DeclareIsolateResult["reason"]): string {
	if (reason === "need-already-set") {
		return vscode.l10n.t("This unit already has a pending need. Resolve it first, then retry.");
	}
	return vscode.l10n.t("Unit not found.");
}

/** 対象ファイルが原文側かを判定する（ワークスペース未設定等は訳文扱い） */
function isSourceFile(filePath: string): boolean {
	try {
		return new FileExplorer().isSourceFile(filePath, Configuration.getInstance());
	} catch {
		return false;
	}
}

/** ツリー項目がユニットであることを確認し、そうでなければエラーを出して undefined を返す */
function requireUnit(item?: StatusItem): UnitStatusItem | undefined {
	if (item?.type !== StatusItemType.Unit || !item.filePath || !item.unitHash) {
		vscode.window.showErrorMessage(vscode.l10n.t("Invalid unit item"));
		return undefined;
	}
	return item;
}

/** ツリー項目がファイルであることを確認し、そうでなければエラーを出して undefined を返す */
function requireFile(item?: StatusItem): FileStatusItem | undefined {
	if (item?.type !== StatusItemType.File || !item.filePath) {
		vscode.window.showErrorMessage(vscode.l10n.t("Invalid file item"));
		return undefined;
	}
	return item;
}

/** modal の detail に載せる確認待ちユニットの一覧（多すぎる場合は件数で畳む） */
function formatPendingTitles(units: UnitStatusItem[]): string {
	const MAX_LISTED = 15;
	const lines = units.slice(0, MAX_LISTED).map((unit) => `• ${unit.title ?? unit.label}`);
	if (units.length > MAX_LISTED) {
		lines.push(vscode.l10n.t("…and {0} more", units.length - MAX_LISTED));
	}
	return lines.join("\n");
}

/** ファイル内の確認待ち（need:verify-deletion）ユニットを取り出す */
function pendingDeletionUnits(file: FileStatusItem): UnitStatusItem[] {
	return getUnitsFromFile(file).filter((unit) => unit.needFlag === "verify-deletion");
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

	/**
	 * verify-deletion: 残す（恒久化）。need と from を外して独立ユニットにする。
	 * need を外すだけでは次の sync で確認待ちが復活する（unit-state.md §14(6)-(a)）。
	 */
	public async keepUnit(item?: StatusItem): Promise<void> {
		const unit = requireUnit(item);
		if (!unit) {
			return;
		}
		const result = await getFileHandler(unit.filePath).keepUnits(unit.filePath, [unit.unitHash]);
		if (result.kept.length === 0) {
			vscode.window.showWarningMessage(describeKeepFailure(result.skipped[0]?.reason));
			return;
		}
		vscode.window.showInformationMessage(
			vscode.l10n.t("Unit kept as independent. It will no longer be matched against the source."),
		);
	}

	/**
	 * verify-deletion: ファイル内の確認待ちをまとめて残す（一括確定）。
	 * 独立化は取り消しの導線が無い操作なので modal で確認する（対象一覧つき）。
	 */
	public async keepAllInFile(item?: StatusItem): Promise<void> {
		const file = requireFile(item);
		if (!file) {
			return;
		}
		const pending = pendingDeletionUnits(file);
		if (pending.length === 0) {
			vscode.window.showWarningMessage(vscode.l10n.t("No units awaiting deletion review in this file."));
			return;
		}
		const confirmLabel = vscode.l10n.t("Keep All");
		const choice = await vscode.window.showWarningMessage(
			vscode.l10n.t("Keep {0} unit(s) awaiting deletion review in '{1}' as independent?", pending.length, file.fileName),
			{
				modal: true,
				detail: `${vscode.l10n.t(
					"mdait will stop matching them against the source. They stay in the document, but re-linking them later is a manual edit.",
				)}\n\n${formatPendingTitles(pending)}`,
			},
			confirmLabel,
		);
		if (choice !== confirmLabel) {
			return;
		}
		const result = await getFileHandler(file.filePath).keepUnits(file.filePath);
		if (result.kept.length === 0) {
			vscode.window.showWarningMessage(vscode.l10n.t("No units awaiting deletion review in this file."));
			return;
		}
		vscode.window.showInformationMessage(vscode.l10n.t("Kept {0} unit(s) as independent.", result.kept.length));
	}

	/**
	 * verify-deletion: ファイル内の確認待ちをまとめて削除する（一括確定）。
	 * 破壊的なので modal で確認する（対象一覧つき）。
	 */
	public async deleteAllInFile(item?: StatusItem): Promise<void> {
		const file = requireFile(item);
		if (!file) {
			return;
		}
		const pending = pendingDeletionUnits(file);
		if (pending.length === 0) {
			vscode.window.showWarningMessage(vscode.l10n.t("No units awaiting deletion review in this file."));
			return;
		}
		const confirmLabel = vscode.l10n.t("Delete All");
		const choice = await vscode.window.showWarningMessage(
			vscode.l10n.t("Delete {0} unit(s) awaiting deletion review from '{1}'?", pending.length, file.fileName),
			{
				modal: true,
				detail: `${vscode.l10n.t(
					"This removes their content from the document — recover via git history if needed.",
				)}\n\n${formatPendingTitles(pending)}`,
			},
			confirmLabel,
		);
		if (choice !== confirmLabel) {
			return;
		}
		const result = await getFileHandler(file.filePath).deleteAllVerifyDeletion(file.filePath);
		if (result.deleted.length === 0) {
			vscode.window.showWarningMessage(vscode.l10n.t("No units awaiting deletion review in this file."));
			return;
		}
		vscode.window.showInformationMessage(vscode.l10n.t("Deleted {0} unit(s).", result.deleted.length));
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
