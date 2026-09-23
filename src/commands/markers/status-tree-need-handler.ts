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
import { getNeedsAttentionLine } from "../../core/status/status-item-tree";
import { getFileHandler } from "../file-handler/file-handler-factory";
import { resolveFileType } from "../file-handler/file-type";
import { advanceAfterReview } from "./needs-attention-next";
import type { NeedTarget } from "./resolve-need";
import { declareIsolateAndReport, deleteUnitAfterConfirm, keepUnitAndReport } from "./unit-decision-actions";

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

/** review 裁定の宛先（どのファイルの、どの単位の need を外すか） */
export interface ReviewTarget {
	filePath: string;
	target: NeedTarget;
	/**
	 * 要対応キューでのこの項目の行（`getNeedsAttentionLine` と同じ。本文ユニットは開始行、
	 * frontmatter と非Markdown は 0）。裁定のあと次の要対応を探す起点になる
	 */
	line: number;
}

/**
 * ツリー項目を review 裁定の宛先に読み替える（純関数。VS Code 非依存）。
 *
 * `need:review` は本文ユニットのほかに frontmatter と非Markdown ファイル（ファイル＝1ユニット）
 * にも載る。要対応ノードはその3種類を並べるので、「レビュー済みにする」も3種類を受ける。
 * どれも書き換えは `getFileHandler().resolveNeed` に渡す `NeedTarget` の違いでしかなく、
 * サーフェス側で分岐して書き換えを実装しない（AGENTS.md の不変条件）。
 *
 * - 本文ユニット → `{ kind: "unit", hash }`
 * - frontmatter → `{ kind: "frontmatter" }`
 * - 非Markdown のファイル行 → `{ kind: "file" }`。Markdown のファイル行は受けない —
 *   Markdown に「ファイル全体を1つの need として外す」単位は無く、`MdFileHandler` は
 *   `kind:"file"` を黙って読み飛ばす（0 件解決）ので、ここで宛先にならないと答える
 *
 * @returns 宛先。裁定の単位にならない項目（ディレクトリ・Markdown のファイル行・壊れた項目）なら undefined
 */
export function toReviewTarget(item?: StatusItem): ReviewTarget | undefined {
	if (!item) {
		return undefined;
	}
	switch (item.type) {
		case StatusItemType.Unit:
			return item.filePath && item.unitHash
				? {
						filePath: item.filePath,
						target: { kind: "unit", hash: item.unitHash },
						line: getNeedsAttentionLine(item),
					}
				: undefined;
		case StatusItemType.Frontmatter:
			return item.filePath
				? { filePath: item.filePath, target: { kind: "frontmatter" }, line: getNeedsAttentionLine(item) }
				: undefined;
		case StatusItemType.File:
			return item.filePath && resolveFileType(item.filePath) === "plain"
				? { filePath: item.filePath, target: { kind: "file" }, line: getNeedsAttentionLine(item) }
				: undefined;
		default:
			return undefined;
	}
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

	/**
	 * review: レビュー済みとして need を外す。
	 * 本文ユニットのほかに frontmatter と非Markdown のファイル行も受ける（`toReviewTarget`）。
	 * 外せたら CodeLens「レビュー完了」と同じく、残っている次の要対応を対訳表示で開く
	 * （`advanceAfterReview`。ADR-260912-08）。要対応ノードの項目で押したときも、ファイル配下の
	 * ユニット行で押したときも同じ — どちらもキューの次へ進む
	 */
	public async markReviewed(item?: StatusItem): Promise<void> {
		const review = toReviewTarget(item);
		if (!review) {
			vscode.window.showErrorMessage(vscode.l10n.t("Invalid unit item"));
			return;
		}
		const result = await getFileHandler(review.filePath).resolveNeed(review.filePath, {
			targets: [review.target],
			needs: ["review"],
		});
		if (result.resolved.length === 0) {
			vscode.window.showWarningMessage(vscode.l10n.t("Nothing to mark as reviewed for this unit."));
			return;
		}
		await advanceAfterReview(result.resolved, { filePath: review.filePath, line: review.line });
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
		await keepUnitAndReport(unit.filePath, unit.unitHash);
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
		// modal に列挙した集合だけを処理する。開いている間に sync が確認待ちを増やしても、
		// 同意していないユニットを巻き込まない（ずれた指定はスキップされる＝安全側）
		const result = await getFileHandler(file.filePath).keepUnits(
			file.filePath,
			pending.map((unit) => unit.unitHash),
		);
		if (result.kept.length === 0) {
			vscode.window.showWarningMessage(
				vscode.l10n.t("The listed units have changed since the dialog was shown. Check the tree and try again."),
			);
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
		// modal に列挙した集合だけを削除する（keepAllInFile と同じ理由。削除は取り返しが
		// つかないので、同意した一覧の外を巻き込まないことが特に重要）
		const result = await getFileHandler(file.filePath).deleteAllVerifyDeletion(
			file.filePath,
			pending.map((unit) => unit.unitHash),
		);
		if (result.deleted.length === 0) {
			vscode.window.showWarningMessage(
				vscode.l10n.t("The listed units have changed since the dialog was shown. Check the tree and try again."),
			);
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
		await deleteUnitAfterConfirm(unit.filePath, unit.unitHash, unit.title ?? unit.label);
	}

	/** isolate 宣言（凍結して下流伝播を止める） */
	public async markIsolated(item?: StatusItem): Promise<void> {
		const unit = requireUnit(item);
		if (!unit) {
			return;
		}
		// 原文側のユニットにも出る（package.json）。通知の向きは宛先で書き分ける
		await declareIsolateAndReport(unit.filePath, unit.unitHash);
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
