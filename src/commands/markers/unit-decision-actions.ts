/**
 * @file unit-decision-actions.ts
 * @description
 *   1ユニットについての判断（残す・削除・凍結）を実行し、結果を人に伝える。
 *
 *   CodeLens とツリーの行は、押す場所が違うだけで同じ操作である。ここで1つにしておかないと、
 *   通知の文言や確認の出し方が片方だけ直って食い違う。書き換えそのものは
 *   `getFileHandler()` の入口を通る（AGENTS.md の不変条件）。
 *
 * @module commands/markers/unit-decision-actions
 */
import * as vscode from "vscode";
import { Configuration } from "../../infra/config/configuration";
import { FileExplorer } from "../../infra/workspace/file-explorer";
import { getFileHandler } from "../file-handler/file-handler-factory";
import type { DeclareIsolateResult } from "./declare-isolate";
import type { DeleteUnitResult } from "./delete-unit";
import type { KeepUnitsResult } from "./keep-unit";

/** 原文側のファイルか（ワークスペース未設定などで判定できなければ訳文扱い） */
export function isSourcePath(filePath: string): boolean {
	try {
		return new FileExplorer().isSourceFile(filePath, Configuration.getInstance());
	} catch {
		return false;
	}
}

/** keepUnits の失敗理由を人が読める文にする */
export function describeKeepFailure(reason: KeepUnitsResult["skipped"][number]["reason"] | undefined): string {
	if (reason === "not-verify-deletion") {
		return vscode.l10n.t(
			"This unit does not have need:verify-deletion. Only units awaiting deletion review can be kept this way.",
		);
	}
	if (reason === "not-found") {
		return vscode.l10n.t("Unit not found.");
	}
	return vscode.l10n.t("Nothing to keep for this unit.");
}

/** deleteUnit の失敗理由を人が読める文にする */
function describeDeleteFailure(reason: DeleteUnitResult["reason"]): string {
	if (reason === "not-verify-deletion") {
		return vscode.l10n.t(
			"This unit does not have need:verify-deletion. Only units flagged for deletion review can be deleted this way.",
		);
	}
	return vscode.l10n.t("Unit not found.");
}

/** declareIsolate の失敗理由を人が読める文にする */
function describeIsolateFailure(reason: DeclareIsolateResult["reason"]): string {
	if (reason === "need-already-set") {
		return vscode.l10n.t("This unit already has a pending need. Resolve it first, then retry.");
	}
	return vscode.l10n.t("Unit not found.");
}

/**
 * verify-deletion のユニットを残す（独立ユニットにする）。
 *
 * need を外すだけでは次の sync で確認待ちが復活するので、need と from を同時に外す
 * （`keepUnits`）。1件の操作なので modal は出さない。
 */
export async function keepUnitAndReport(filePath: string, unitHash: string): Promise<void> {
	const result = await getFileHandler(filePath).keepUnits(filePath, [unitHash]);
	if (result.kept.length === 0) {
		vscode.window.showWarningMessage(describeKeepFailure(result.skipped[0]?.reason));
		return;
	}
	vscode.window.showInformationMessage(
		vscode.l10n.t("Unit kept as independent. It will no longer be matched against the source."),
	);
}

/**
 * verify-deletion のユニットを文書から取り除く。取り返しがつかないので modal で確かめる。
 *
 * @param title 確認文に出すユニットの名前（分からなければ「このユニット」と書く）
 */
export async function deleteUnitAfterConfirm(filePath: string, unitHash: string, title?: string): Promise<void> {
	const confirmLabel = vscode.l10n.t("Delete");
	const choice = await vscode.window.showWarningMessage(
		title
			? vscode.l10n.t(
					"Delete unit '{0}' from the document? This removes its content — recover via git history if needed.",
					title,
				)
			: vscode.l10n.t(
					"Delete this unit from the document? This removes its content — recover via git history if needed.",
				),
		{ modal: true },
		confirmLabel,
	);
	if (choice !== confirmLabel) {
		return;
	}
	const result = await getFileHandler(filePath).deleteUnit(filePath, { kind: "unit", hash: unitHash });
	if (!result.deleted) {
		vscode.window.showWarningMessage(describeDeleteFailure(result.reason));
		return;
	}
	vscode.window.showInformationMessage(vscode.l10n.t("Unit deleted."));
}

/**
 * ユニットを凍結する（need:isolate）。
 *
 * 意味は向きで変わる — 訳文は原文の更新に追従しなくなり、原文は訳文へ伝わらなくなる。
 * 通知もそれに合わせて書き分ける。
 */
export async function declareIsolateAndReport(filePath: string, unitHash: string): Promise<void> {
	const result = await getFileHandler(filePath).declareIsolate(filePath, { kind: "unit", hash: unitHash });
	if (!result.declared) {
		vscode.window.showWarningMessage(describeIsolateFailure(result.reason));
		return;
	}
	vscode.window.showInformationMessage(
		isSourcePath(filePath)
			? vscode.l10n.t("Unit marked as isolated. It will no longer propagate to the translations.")
			: vscode.l10n.t("Unit marked as isolated. It will no longer follow source updates."),
	);
}
