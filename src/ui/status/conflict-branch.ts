/**
 * @file conflict-branch.ts
 * @description
 *   StatusTree の「競合の解決」の枝を組み立てる（roadmap-v04 P01）。
 *
 *   置き場は `docs/ux.md` §3.3 の表に従う。**気づき**はステータスバーの1行、
 *   **状態と操作**はこの枝（1件1行）、**解説**は Hover（＝ツリー行のツールチップ）である。
 *   合流のたびにトーストは出さない（変化の気づきは1箇所に集約する）。
 *
 *   この段（P01）では**見せるだけ**で、行内の操作はまだ無い。解くのは P02（✨AI の一発）と
 *   P03（`こちらを採る` / `あちらを採る`）である。
 *
 * @module ui/status/conflict-branch
 */
import * as path from "node:path";
import * as vscode from "vscode";
import type { ConflictFileKind, MdaitConflicts } from "../../core/conflict/mdait-conflicts";
import { type DirectoryStatusItem, Status, StatusItemType } from "../../core/status/status-item";

/** ルート直下の「競合の解決」仮想ノードの識別子（実在するパスと衝突しない形にする） */
export const CONFLICTS_ID = "mdait:conflicts";

/** 枝の中の1行の識別子の接頭辞 */
const CONFLICT_ROW_PREFIX = "mdait:conflict:";

/** その `directoryPath` が「競合の解決」の枝の中の行か */
export function isConflictRowId(directoryPath: string): boolean {
	return directoryPath.startsWith(CONFLICT_ROW_PREFIX);
}

/** 競合したファイルの、人が読む名前 */
function fileKindLabel(kind: ConflictFileKind): string {
	switch (kind) {
		case "unit-state":
			return vscode.l10n.t("Unit state");
		case "unit-registry":
			return vscode.l10n.t("Source snapshots");
		case "tm":
			return vscode.l10n.t("Translation memory");
		case "terms":
			return vscode.l10n.t("Glossary");
	}
}

/** 競合したファイルごとの、いま何が起きているかの解説（Hover） */
function fileKindExplanation(kind: ConflictFileKind): string {
	switch (kind) {
		case "unit-state":
			return vscode.l10n.t(
				"Two branches wrote different values for the same translation unit. mdait keeps every row it can read, so nothing is lost, but the conflict markers are still in the file.",
			);
		case "unit-registry":
			return vscode.l10n.t(
				"Two branches added different source snapshots. Snapshots are never chosen between — both sides are kept, because each one is a past version of a source document that exists nowhere else.",
			);
		case "tm":
			return vscode.l10n.t(
				"Two branches registered different translations. While the conflict markers are there, mdait refuses to read or save the translation memory, so nothing is overwritten.",
			);
		case "terms":
			return vscode.l10n.t(
				"Two branches edited the glossary. While the conflict markers are there, mdait refuses to read it, so AI translation runs without glossary terms until this is resolved.",
			);
	}
}

/**
 * 「競合の解決」の枝を作る。0件なら `undefined`（空のノードをツリーに出さない — UX-P7）。
 */
export function buildConflictsItem(conflicts: MdaitConflicts): DirectoryStatusItem | undefined {
	if (conflicts.total === 0) {
		return undefined;
	}
	return {
		type: StatusItemType.Directory,
		label: vscode.l10n.t("Merge conflicts ({0})", conflicts.total),
		status: Status.Error,
		directoryPath: CONFLICTS_ID,
		contextValue: "mdaitConflictsRoot",
		tooltip: vscode.l10n.t(
			"Merging left conflicts inside .mdait. Nothing has been lost, but mdait cannot use these files until the conflicts are resolved.",
		),
	};
}

/**
 * 枝の中の行を作る。**1件1行**で、何が読めるかは対象で決まる。
 *
 * - ファイル … 種別と、ワークスペースから見たパス
 * - 合流で降ろされた行 … 原稿のファイル名と、預かっている状態（`need` / `from`）
 */
export function buildConflictRows(
	conflicts: MdaitConflicts,
	workspaceRoot: string | undefined,
): DirectoryStatusItem[] {
	const shortPath = (absolute: string) =>
		workspaceRoot ? path.relative(workspaceRoot, absolute).split(path.sep).join("/") : absolute;

	const fileRows = conflicts.files.map((file): DirectoryStatusItem => ({
		type: StatusItemType.Directory,
		label: fileKindLabel(file.kind),
		description: shortPath(file.filePath),
		status: Status.Error,
		directoryPath: `${CONFLICT_ROW_PREFIX}file:${file.kind}`,
		contextValue: "mdaitConflictFile",
		tooltip: `${shortPath(file.filePath)}\n\n${fileKindExplanation(file.kind)}`,
	}));

	const heldRows = conflicts.heldRows.map((row, index): DirectoryStatusItem => ({
		type: StatusItemType.Directory,
		label: path.basename(row.path),
		description: row.need
			? vscode.l10n.t("held state: {0}", row.need)
			: vscode.l10n.t("held state: translated"),
		status: Status.Error,
		directoryPath: `${CONFLICT_ROW_PREFIX}held:${index}`,
		contextValue: "mdaitConflictHeldRow",
		tooltip: vscode.l10n.t(
			"{0}\n\nTwo branches wrote different states for the same chapter, so one of them was taken off its seat. It is kept, not discarded — but it will only come back on its own if the chapter's text matches it exactly.\n\nHeld state: from={1} need={2}",
			row.path,
			row.from || "—",
			row.need || "—",
		),
	}));

	return [...fileRows, ...heldRows];
}
