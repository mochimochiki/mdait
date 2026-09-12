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
import { decisionOf } from "../../commands/conflict/conflict-decisions";
import { conflictKindLabel } from "../../commands/conflict/conflict-kind";
import type { PendingChoice, ResolutionPlan } from "../../commands/conflict/resolution-plan";
import { calculateHash } from "../../core/hash/hash-calculator";
import type { ConflictFileKind, MdaitConflicts } from "../../core/conflict/mdait-conflicts";
import { type DirectoryStatusItem, Status, StatusItemType } from "../../core/status/status-item";

/** ルート直下の「競合の解決」仮想ノードの識別子（実在するパスと衝突しない形にする） */
export const CONFLICTS_ID = "mdait:conflicts";

/** 枝の中の1行の識別子の接頭辞 */
const CONFLICT_ROW_PREFIX = "mdait:conflict:";

/** 競合したファイルの行の識別子（開くと、その中の1件1行が出る） */
const CONFLICT_FILE_PREFIX = `${CONFLICT_ROW_PREFIX}file:`;

/** そのファイルの中の1件を指す行の識別子 */
const CONFLICT_CHOICE_PREFIX = `${CONFLICT_ROW_PREFIX}choice:`;

/** その `directoryPath` が「競合の解決」の枝の中の行か */
export function isConflictRowId(directoryPath: string): boolean {
	return directoryPath.startsWith(CONFLICT_ROW_PREFIX);
}

/** その行が「競合したファイル」の行か（開くと中の1件が出る） */
export function isConflictFileRowId(directoryPath: string): boolean {
	return directoryPath.startsWith(CONFLICT_FILE_PREFIX);
}

/** ファイルの行の識別子から、そのファイルの絶対パスを取り出す */
export function filePathOfConflictRow(directoryPath: string): string | undefined {
	return directoryPath.startsWith(CONFLICT_FILE_PREFIX) ? directoryPath.slice(CONFLICT_FILE_PREFIX.length) : undefined;
}

/** 競合したファイルごとの、いま何が起きているかの解説（Hover） */
function fileKindExplanation(kind: ConflictFileKind): string {
	switch (kind) {
		case "unit-state":
			return vscode.l10n.t(
				"Two branches wrote different values for the same translation unit. Every row that can be read is kept, so there is nothing to choose between — resolving removes the conflict markers.",
			);
		case "unit-registry":
			return vscode.l10n.t(
				"Two branches added different source snapshots. Snapshots are never chosen between — both sides are kept, because each one is a past version of a source document that exists nowhere else.",
			);
		case "tm":
			return vscode.l10n.t(
				"Two branches registered different translations. While the conflict markers are there, mdait cannot read the translation memory: past translations are not offered while translating, and nothing new can be committed to it.",
			);
		case "terms":
			return vscode.l10n.t(
				"Two branches edited the glossary. While the conflict markers are there, mdait cannot read it, so AI translation runs without glossary terms until this is resolved.",
			);
	}
}

/**
 * 「競合の解決」の枝を作る。0件なら `undefined`（空のノードをツリーに出さない — UX-P7）。
 */
export function buildConflictsItem(conflicts: MdaitConflicts, decisions: number | undefined): DirectoryStatusItem | undefined {
	if (conflicts.total === 0) {
		return undefined;
	}
	return {
		type: StatusItemType.Directory,
		// 数えるのは**あなたが決める件数**。ファイルの数でも自動で片付く件数でもない
		label: decisions ? vscode.l10n.t("Conflicts ({0})", decisions) : vscode.l10n.t("Conflicts"),
		status: Status.Error,
		directoryPath: CONFLICTS_ID,
		contextValue: "mdaitConflictsRoot",
		// **数字が何を数えているかは、ラベルからは読めない。** 件数を出しているときだけ、
		// それが「あなたが決める件数」であることを言う（自動で片付く分は数に入っていない）
		tooltip: decisions
			? vscode.l10n.t("Merging left conflicts inside .mdait. The number counts the ones still waiting for your decision.")
			: vscode.l10n.t("Merging left conflicts inside .mdait."),
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
	/** 人が決める件の数（ファイルの絶対パス → 件数）。開けるかどうかの判断に使う */
	pendingCounts: ReadonlyMap<string, number> = new Map(),
): DirectoryStatusItem[] {
	const shortPath = (absolute: string) =>
		workspaceRoot ? path.relative(workspaceRoot, absolute).split(path.sep).join("/") : absolute;

	const fileRows = conflicts.files.map((file): DirectoryStatusItem => {
		const pending = pendingCounts.get(file.filePath) ?? 0;
		return {
			type: StatusItemType.Directory,
			// 対象の名前と、その中で決める件数だけ。パスは Hover に降ろす
			label: pending > 0 ? `${conflictKindLabel(file.kind)}（${pending}）` : conflictKindLabel(file.kind),
			status: Status.Error,
			directoryPath: `${CONFLICT_FILE_PREFIX}${file.filePath}`,
			contextValue: "mdaitConflictFile",
			tooltip: `${shortPath(file.filePath)}\n\n${fileKindExplanation(file.kind)}`,
		};
	});

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
			"{0}\n\nTwo branches wrote different states for the same chapter, so one of them was taken off its seat. Running Sync matches it against your documents: the side whose text matches goes back to its seat.",
			row.path,
		),
	}));

	return [...fileRows, ...heldRows];
}

/**
 * 競合したファイルを開いたときに出る、**1件1行**（roadmap-v04 P03）。
 *
 * 行には「こちらを採る」「あちらを採る」が付く（`package.json` の `viewItem` で引く）。
 * **✨は付けない** — AI を1回も呼ばないからである（UX-P4 の逆向き）。
 *
 * 既に決めた件は、どちらを採ったかを副題に出す。決めただけではまだ書かれていない
 * （そのファイルの最後の1件が決まったときにまとめて書く）ことも Hover に書く。
 */
export function buildConflictChoiceRows(plan: ResolutionPlan, stamp: string): DirectoryStatusItem[] {
	return plan.pending.map((item, index) => {
		const chosen = decisionOf(plan.filePath, stamp, item.key);
		return {
			type: StatusItemType.Directory,
			label: shorten(item.label),
			// **状態を一言だけ。** 削除がからむかどうかは Hover が言う
			description: chosen
				? chosen === "ours"
					? vscode.l10n.t("yours")
					: vscode.l10n.t("theirs")
				: vscode.l10n.t("not chosen"),
			status: Status.Error,
			directoryPath: `${CONFLICT_CHOICE_PREFIX}${index}:${fingerprintOfKey(item.key)}:${plan.filePath}`,
			contextValue: chosen ? "mdaitConflictChoiceDecided" : "mdaitConflictChoice",
			tooltip: buildChoiceTooltip(item, chosen),
		};
	});
}

/**
 * 行の識別子に載せる、その件の鍵の短い目印。
 *
 * 鍵そのものを載せないのは、長い（席のキーやハッシュ）からである。**番号だけでは足りない** —
 * ツリーに出したままファイルが外から変わると、同じ番号が別の件を指しうる。押した行が
 * いまも同じ件を指しているかは、この目印で確かめる。
 */
export function fingerprintOfKey(key: string): string {
	return calculateHash(key);
}

/** ツリーの1行に収まる長さへ。記法の印（`**` など）は読めないので落とす */
function shorten(text: string, max = 40): string {
	const plain = text.replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();
	return plain.length > max ? `${plain.slice(0, max)}…` : plain;
}

/**
 * 1件の解説（Hover）。
 *
 * **見出し・3つの値・やること**の3つだけを置く。仕組みの説明（いつ書き込むか、AI を
 * 使うか）は書かない — 操作の結果を見れば分かることで、読ませる意味がない
 * （`docs/ux.md` §3.3）。
 */
function buildChoiceTooltip(item: PendingChoice, chosen: "ours" | "theirs" | undefined): string {
	const parts = [
		item.label,
		"",
		`${vscode.l10n.t("You")}\t${item.oursDeleted ? vscode.l10n.t("deleted") : item.oursText}`,
		`${vscode.l10n.t("They")}\t${item.theirsDeleted ? vscode.l10n.t("deleted") : item.theirsText}`,
	];
	if (item.baseText !== undefined) {
		parts.push(`${vscode.l10n.t("Before")}\t${item.baseText}`);
	}
	parts.push("", vscode.l10n.t("Choose which one to keep."));
	// 消した側を採ると項目ごと消える。結果が値の表から読めないので、そこだけ足す
	if (item.theirsDeleted) {
		parts.push(vscode.l10n.t("Taking theirs removes this entry."));
	} else if (item.oursDeleted) {
		parts.push(vscode.l10n.t("Taking yours removes this entry."));
	}
	if (chosen) {
		parts.push(
			chosen === "ours" ? vscode.l10n.t("Chosen: yours.") : vscode.l10n.t("Chosen: theirs."),
		);
	}
	return parts.join("\n");
}

/** 行の識別子から、そのファイルの絶対パス・何番目か・鍵の目印を取り出す */
export function choiceOfConflictRow(
	directoryPath: string,
): { filePath: string; index: number; fingerprint: string } | undefined {
	if (!directoryPath.startsWith(CONFLICT_CHOICE_PREFIX)) {
		return undefined;
	}
	const rest = directoryPath.slice(CONFLICT_CHOICE_PREFIX.length);
	const first = rest.indexOf(":");
	if (first < 0) {
		return undefined;
	}
	const second = rest.indexOf(":", first + 1);
	if (second < 0) {
		return undefined;
	}
	const index = Number.parseInt(rest.slice(0, first), 10);
	return Number.isInteger(index)
		? { filePath: rest.slice(second + 1), index, fingerprint: rest.slice(first + 1, second) }
		: undefined;
}
